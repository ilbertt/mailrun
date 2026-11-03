import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner } from "./fixtures";
import {
	imapLoginSchema,
	parseImapImport,
	listImapFolders,
	fetchImapBatch,
} from "../src/server/mail-transfer/imap";
import {
	connectImap,
	dialImapTransport,
	isPublicImapAddress,
	normalizeImapHost,
	type ImapNetwork,
	type ImapTransport,
} from "../src/server/mail-transfer/imap-network";
import { importMessages } from "../src/server/mail-transfer/import";
import { LocalStorage } from "../src/server/storage";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
const login = {
	host: "imap.example.net",
	port: 993,
	secure: true,
	username: "fixture@example.net",
	password: "synthetic-only-password",
};
const body = (uid: string) =>
	new TextEncoder().encode(
		`From: sender@example.org\r\nTo: hello@example.com\r\nSubject: IMAP ${uid}\r\nMessage-ID: <imap-${uid}@example.org>\r\n\r\nCafé UID ${uid}\r\n`,
	);
function simulator(
	options: {
		uids?: string[];
		greeting?: string;
		loginFailure?: boolean;
		truncated?: boolean;
		oversized?: boolean;
		maxChunk?: number;
	} = {},
) {
	const commands: string[] = [],
		dialed: Parameters<ImapNetwork["dial"]>[0][] = [],
		pending: Uint8Array[] = [];
	let closed = false;
	const push = (bytes: Uint8Array) => {
		const size = options.maxChunk ?? 7;
		for (let i = 0; i < bytes.length; i += size)
			pending.push(bytes.subarray(i, i + size));
	};
	push(
		new TextEncoder().encode(options.greeting ?? "* OK Local IMAP fixture\r\n"),
	);
	const transport: ImapTransport = {
		async read() {
			return pending.shift() ?? null;
		},
		close() {
			closed = true;
		},
		async write(value) {
			const line = new TextDecoder().decode(value);
			commands.push(line);
			const tag = line.split(" ")[0]!;
			let response = "";
			if (line.includes(" LOGIN "))
				response = options.loginFailure
					? `${tag} NO Echoing synthetic-only-password\r\n`
					: `${tag} OK Logged in\r\n`;
			else if (line.includes(" LIST "))
				response = `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST () "/" "Sent Items"\r\n* LIST () "/" "Archive/2025"\r\n* LIST () "/" "A \\"quote\\""\r\n${tag} OK Listed\r\n`;
			else if (line.includes(" SELECT "))
				response = `* 4 EXISTS\r\n${tag} OK Selected\r\n`;
			else if (line.includes(" UID SEARCH "))
				response = `* SEARCH ${(options.uids ?? ["1", "2", "10", "12"]).join(" ")}\r\n${tag} OK Searched\r\n`;
			else if (line.includes(" UID FETCH ")) {
				const uid = line.match(/UID FETCH (\d+)/)?.[1] ?? "0",
					raw = body(uid);
				const prefix = new TextEncoder().encode(
					`* 1 FETCH (UID ${uid} RFC822 {${options.oversized ? 129 * 1024 * 1024 : raw.length}}\r\n`,
				);
				push(prefix);
				if (!options.oversized) {
					push(options.truncated ? raw.subarray(0, 5) : raw);
					if (!options.truncated)
						push(new TextEncoder().encode(`)\r\n${tag} OK Fetched\r\n`));
				}
				return;
			} else if (line.includes(" LOGOUT"))
				response = `* BYE Bye\r\n${tag} OK Logout\r\n`;
			else throw new Error("Unexpected fixture command");
			push(new TextEncoder().encode(response));
		},
	};
	const network: ImapNetwork = {
		resolve: async () => [{ address: "93.184.216.34", family: 4 }],
		dial: async (target) => {
			dialed.push(target);
			return transport;
		},
	};
	return {
		network,
		commands,
		dialed,
		get closed() {
			return closed;
		},
	};
}
test("IMAP listing and login preserve quoting and handle fragmented CRLF replies", async () => {
	const fake = simulator({ maxChunk: 1 }),
		input = imapLoginSchema.parse({
			...login,
			username: 'user"\\name',
			password: 'pass"\\word',
		});
	const folders = await listImapFolders(input, fake.network);
	expect(folders).toEqual(["INBOX", "Sent Items", "Archive/2025", 'A "quote"']);
	expect(fake.commands[0]).toBe(
		'A0001 LOGIN "user\\"\\\\name" "pass\\"\\\\word"\r\n',
	);
	expect(fake.closed).toBe(true);
	expect(fake.dialed[0]).toMatchObject({
		host: "imap.example.net",
		address: "93.184.216.34",
		secure: true,
	});
});
test("IMAP batches retain total/offset semantics and stream spooled raw MIME one message at a time", async () => {
	const input = parseImapImport({
			...login,
			mailboxId: "mailbox",
			folder: "Archive/2025",
			limit: 2,
		}),
		fake = simulator();
	const batch = await fetchImapBatch(input, fake.network);
	try {
		expect(batch.total).toBe(4);
		expect(batch.nextOffset).toBe(2);
		const files = await Array.fromAsync(batch.messages());
		expect(files.map((file) => file.filename)).toEqual([
			"Archive/2025-10.eml",
			"Archive/2025-12.eml",
		]);
		expect(files[0]?.raw).toEqual(body("10").buffer);
		expect(
			await importMessages(owner, input.mailboxId, input.destination, files),
		).toEqual({ imported: 2, skipped: 0, errors: [] });
	} finally {
		await batch.cleanup();
	}
	const older = await fetchImapBatch(
		{ ...input, offset: 2 },
		simulator().network,
	);
	try {
		expect(older.nextOffset).toBeNull();
		expect(
			(
				await importMessages(
					owner,
					input.mailboxId,
					input.destination,
					older.messages(),
				)
			).imported,
		).toBe(2);
	} finally {
		await older.cleanup();
	}
	expect(
		state.db
			.query(
				"SELECT subject FROM messages WHERE provider_message_id LIKE '<imap-%' ORDER BY created_at,id",
			)
			.all(),
	).toHaveLength(4);
	expect(fake.closed).toBe(true);
	expect(
		await Array.fromAsync(
			new Bun.Glob("import-staging/*/*").scan({ cwd: new LocalStorage().root }),
		),
	).toEqual([]);
});
test("empty folders and offsets beyond the end finish without FETCH calls", async () => {
	for (const options of [{ uids: [] }, { uids: ["1", "2"] }]) {
		const fake = simulator(options),
			batch = await fetchImapBatch(
				parseImapImport({ ...login, mailboxId: "mailbox", offset: 100 }),
				fake.network,
			);
		try {
			expect(batch.nextOffset).toBeNull();
			expect(await Array.fromAsync(batch.messages())).toEqual([]);
			expect(
				fake.commands.some((command) => command.includes(" UID FETCH ")),
			).toBe(false);
		} finally {
			await batch.cleanup();
		}
	}
});
test("authentication failure never echoes a credential, and a bad greeting never sends LOGIN", async () => {
	const failed = simulator({ loginFailure: true });
	let error: unknown;
	try {
		await listImapFolders(login, failed.network);
	} catch (cause) {
		error = cause;
	}
	expect(error).toBeInstanceOf(Error);
	expect(String(error)).not.toContain(login.password);
	expect(String(error)).toContain("LOGIN command failed");
	expect(failed.closed).toBe(true);
	const refused = simulator({ greeting: "* BYE No access\r\n" });
	await expect(listImapFolders(login, refused.network)).rejects.toThrow(
		"OK greeting",
	);
	expect(refused.commands).toEqual([]);
	expect(refused.closed).toBe(true);
});
test("truncated or oversized literals clean staging files and do not import a partial batch", async () => {
	for (const options of [{ truncated: true }, { oversized: true }]) {
		const fake = simulator(options);
		await expect(
			fetchImapBatch(
				parseImapImport({ ...login, mailboxId: "mailbox" }),
				fake.network,
			),
		).rejects.toThrow();
		expect(fake.closed).toBe(true);
		expect(
			await Array.fromAsync(
				new Bun.Glob("import-staging/*/*").scan({
					cwd: new LocalStorage().root,
				}),
			),
		).toEqual([]);
	}
	expect(state.db.query("SELECT id FROM messages").all()).toHaveLength(1);
});
test("IMAP validation rejects command injection and retains source batch defaults/clamps", () => {
	for (const field of ["host", "username", "password", "folder"])
		expect(() =>
			parseImapImport({
				...login,
				mailboxId: "mailbox",
				[field]: "safe\r\nA0009 DELETE INBOX",
			}),
		).toThrow();
	expect(
		parseImapImport({
			...login,
			mailboxId: "mailbox",
			port: 143,
			secure: undefined,
			limit: 500,
			offset: -3,
		}),
	).toMatchObject({ secure: false, limit: 100, offset: 0, folder: "INBOX" });
	for (const value of [0, 65536, 1.2])
		expect(() => imapLoginSchema.parse({ ...login, port: value })).toThrow();
});
test("private and alternative-address IMAP targets are rejected before any TCP dial", async () => {
	for (const host of [
		"localhost",
		"host.local",
		"127.0.0.1",
		"127.1",
		"2130706433",
		"0x7f000001",
		"10.1.1.1",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"::1",
		"[fc00::1]",
		"::ffff:7f00:1",
	]) {
		let dialed = false;
		const network: ImapNetwork = {
			resolve: async () => [{ address: "127.0.0.1", family: 4 }],
			dial: async () => {
				dialed = true;
				throw new Error("Should not dial");
			},
		};
		await expect(connectImap({ ...login, host }, network)).rejects.toThrow();
		expect(dialed).toBe(false);
	}
	expect(isPublicImapAddress("93.184.216.34")).toBe(true);
	expect(isPublicImapAddress("2001:4860:4860::8888")).toBe(true);
	expect(isPublicImapAddress("2001:db8::1")).toBe(false);
	expect(normalizeImapHost("IMAP.Example.Net.")).toBe("imap.example.net");
});
test("DNS addresses are validated together and pinned while IPv6 connection failure can fall back to IPv4", async () => {
	let dialed = 0;
	await expect(
		connectImap(login, {
			resolve: async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.0.0.1", family: 4 },
			],
			dial: async () => {
				dialed++;
				throw new Error("Should not dial");
			},
		}),
	).rejects.toThrow("Private");
	expect(dialed).toBe(0);
	const fake = simulator(),
		seen: string[] = [];
	const connection = await connectImap(login, {
		resolve: async () => [
			{ address: "2001:4860:4860::8888", family: 6 },
			{ address: "93.184.216.34", family: 4 },
		],
		dial: async (target) => {
			seen.push(target.address);
			expect(target.host).toBe("imap.example.net");
			if (target.family === 6) throw new Error("IPv6 unreachable");
			return fake.network.dial(target);
		},
	});
	connection.close();
	expect(seen).toEqual(["2001:4860:4860::8888", "93.184.216.34"]);
});
test("native TCP and TLS transport verify the original hostname while connecting to a pinned IP", async () => {
	const key = `${state.directory}/imap-key.pem`,
		cert = `${state.directory}/imap-cert.pem`,
		openssl = Bun.which("openssl");
	expect(openssl).not.toBeNull();
	const generated = Bun.spawnSync(
		[
			openssl!,
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=imap.example.net",
			"-addext",
			"subjectAltName=DNS:imap.example.net",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(generated.exitCode).toBe(0);
	const commands: string[] = [];
	const createServer = (tls?: { key: string; cert: string }) =>
		Bun.listen<{ buffer: string }>({
			hostname: "127.0.0.1",
			port: 0,
			tls,
			socket: {
				open(socket) {
					socket.data = { buffer: "" };
					socket.write("* OK Native fixture\r\n");
				},
				data(socket, data) {
					socket.data.buffer += data.toString();
					while (socket.data.buffer.includes("\r\n")) {
						const end = socket.data.buffer.indexOf("\r\n"),
							line = socket.data.buffer.slice(0, end);
						socket.data.buffer = socket.data.buffer.slice(end + 2);
						commands.push(line);
						const tag = line.split(" ")[0]!;
						socket.write(
							line.includes(" LIST ")
								? `* LIST () "/" "INBOX"\r\n${tag} OK Listed\r\n`
								: `${tag} OK Done\r\n`,
						);
					}
				},
				error() {},
			},
		});
	const plain = createServer(),
		secure = createServer({
			key: await Bun.file(key).text(),
			cert: await Bun.file(cert).text(),
		});
	try {
		const network = (encrypted: boolean, trust = false): ImapNetwork => ({
			resolve: async () => [{ address: "93.184.216.34", family: 4 }],
			dial: async (target) =>
				dialImapTransport(
					{
						...target,
						address: "127.0.0.1",
						port: encrypted ? secure.port : plain.port,
					},
					trust ? { ca: await Bun.file(cert).text() } : undefined,
				),
		});
		expect(
			await listImapFolders({ ...login, secure: false }, network(false)),
		).toEqual(["INBOX"]);
		expect(await listImapFolders(login, network(true, true))).toEqual([
			"INBOX",
		]);
		const before = commands.length;
		await expect(listImapFolders(login, network(true))).rejects.toThrow();
		expect(commands).toHaveLength(before);
		await expect(
			listImapFolders(
				{ ...login, host: "wrong.example.net" },
				network(true, true),
			),
		).rejects.toThrow();
		expect(commands).toHaveLength(before);
	} finally {
		plain.stop(true);
		secure.stop(true);
	}
}, 15_000);

test("aborting an active IMAP fetch closes its socket and clears the partial staging batch", async () => {
	let fetched: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		fetched = resolve;
	});
	const server = Bun.listen<{ buffer: string }>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { buffer: "" };
				socket.write("* OK Cancel fixture\r\n");
			},
			data(socket, bytes) {
				socket.data.buffer += bytes.toString();
				while (socket.data.buffer.includes("\r\n")) {
					const end = socket.data.buffer.indexOf("\r\n"),
						line = socket.data.buffer.slice(0, end);
					socket.data.buffer = socket.data.buffer.slice(end + 2);
					const tag = line.split(" ")[0]!;
					if (line.includes(" UID FETCH ")) {
						socket.write("* 1 FETCH (RFC822 {10000}\r\npartial");
						fetched();
					} else if (line.includes(" UID SEARCH "))
						socket.write(`* SEARCH 1\r\n${tag} OK Search\r\n`);
					else socket.write(`${tag} OK Done\r\n`);
				}
			},
			error() {},
		},
	});
	const controller = new AbortController(),
		input = parseImapImport({ ...login, secure: false, mailboxId: "mailbox" });
	const network: ImapNetwork = {
		resolve: async () => [{ address: "93.184.216.34", family: 4 }],
		dial: (target) =>
			dialImapTransport({ ...target, address: "127.0.0.1", port: server.port }),
	};
	const fetching = fetchImapBatch(input, network, controller.signal);
	try {
		await started;
		controller.abort();
		await expect(fetching).rejects.toThrow("cancelled");
		expect(
			await Array.fromAsync(
				new Bun.Glob("import-staging/*/*").scan({
					cwd: new LocalStorage().root,
				}),
			),
		).toEqual([]);
	} finally {
		controller.abort();
		await fetching.catch(() => {});
		server.stop(true);
	}
});

test("UID batches ignore malformed search tokens in the same way as the source parser", async () => {
	const fake = simulator({ uids: ["1", "bad", "2:3", "2", "7"] }),
		batch = await fetchImapBatch(
			parseImapImport({ ...login, mailboxId: "mailbox", limit: 2 }),
			fake.network,
		);
	try {
		expect(batch.total).toBe(3);
		expect(batch.nextOffset).toBe(2);
		expect(
			(await Array.fromAsync(batch.messages())).map((file) => file.filename),
		).toEqual(["INBOX-2.eml", "INBOX-7.eml"]);
	} finally {
		await batch.cleanup();
	}
});
