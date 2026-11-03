import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import type { ImportMessageInput } from "../../lib/import/types";
import {
	quoteImapString,
	parseListMailboxName,
	isTaggedCompletion,
} from "../../lib/import/imap-utils";
import { parseImportDestination } from "../../lib/import/destination";
import { LocalStorage } from "../storage";
import { id } from "../db";
import {
	connectImap,
	type ImapTransport,
	type ImapNetwork,
} from "./imap-network";
const clean = (max: number) =>
	z
		.string()
		.max(max)
		.refine(
			(value) => !/[\r\n\0]/.test(value),
			"IMAP values cannot contain control characters",
		);
export const imapLoginSchema = z
	.object({
		host: clean(253).trim().min(1),
		port: z.coerce.number().int().min(1).max(65535).default(993),
		secure: z.boolean().optional(),
		username: clean(1024).trim().min(1),
		password: clean(4096).min(1),
	})
	.transform((value) => ({
		...value,
		secure: value.secure ?? value.port === 993,
	}));
export function parseImapImport(value: unknown) {
	const input = z
		.object({
			mailboxId: z.string().min(1),
			destination: z.unknown().optional(),
			folder: clean(2048).trim().default("INBOX"),
			limit: z.coerce.number().finite().default(100),
			offset: z.coerce.number().finite().default(0),
		})
		.parse(value);
	return {
		...imapLoginSchema.parse(value),
		...input,
		folder: input.folder || "INBOX",
		destination: parseImportDestination(input.destination),
		limit: Math.min(Math.max(Math.floor(input.limit), 1), 100),
		offset: Math.max(Math.floor(input.offset), 0),
	};
}
class ImapConnection {
	private buffer: Uint8Array = new Uint8Array();
	private offset = 0;
	private counter = 0;
	private deadline = Date.now() + 15_000;
	constructor(private transport: ImapTransport) {}
	close() {
		this.transport.close();
	}
	private async more() {
		if (Date.now() > this.deadline) throw new Error("IMAP command timed out");
		if (this.offset < this.buffer.length) return;
		const next = await this.transport.read();
		if (!next?.length) throw new Error("IMAP connection closed unexpectedly");
		this.buffer = next;
		this.offset = 0;
	}
	private async readLine() {
		const pieces: Uint8Array[] = [];
		let size = 0;
		while (true) {
			await this.more();
			const end = this.buffer.indexOf(10, this.offset);
			const piece = this.buffer.subarray(
				this.offset,
				end < 0 ? this.buffer.length : end,
			);
			pieces.push(piece);
			size += piece.length;
			if (size > 16 * 1024 * 1024)
				throw new Error("IMAP response line is too large");
			this.offset = end < 0 ? this.buffer.length : end + 1;
			if (end >= 0) {
				const line = Buffer.concat(pieces, size);
				if (line[line.length - 1] !== 13)
					throw new Error("Invalid IMAP response line");
				return line.subarray(0, -1).toString("utf8");
			}
		}
	}
	private async write(value: string) {
		await this.transport.write(new TextEncoder().encode(value));
	}
	private tag() {
		return `A${String(++this.counter).padStart(4, "0")}`;
	}
	async greeting() {
		if (!(await this.readLine()).startsWith("* OK"))
			throw new Error("IMAP server did not send an OK greeting");
	}
	async command(command: string) {
		this.deadline = Date.now() + 60_000;
		const tag = this.tag();
		await this.write(`${tag} ${command}\r\n`);
		const lines: string[] = [];
		let size = 0;
		while (true) {
			const line = await this.readLine();
			size += line.length;
			if (size > 32 * 1024 * 1024 || lines.length >= 10_000)
				throw new Error("IMAP command response is too large");
			lines.push(line);
			if (isTaggedCompletion(line, tag)) {
				if (!/^A\d+ OK(?:\s|$)/i.test(line))
					throw new Error(`IMAP ${command.split(" ")[0]} command failed`);
				return lines;
			}
		}
	}
	async fetchMessage(uid: string, path: string) {
		this.deadline = Date.now() + 60_000;
		const tag = this.tag();
		await this.write(`${tag} UID FETCH ${uid} (RFC822)\r\n`);
		let found = false,
			lines = 0;
		while (true) {
			const line = await this.readLine();
			if (++lines > 10_000) throw new Error("IMAP fetch response is too large");
			const match = /\{(\d+)\+?\}$/.exec(line);
			if (match) {
				if (found)
					throw new Error("IMAP fetch returned multiple message bodies");
				found = true;
				let remaining = Number(match[1]);
				if (!Number.isSafeInteger(remaining) || remaining > 128 * 1024 * 1024)
					throw new Error("IMAP message exceeds 128 MiB");
				await Bun.write(path, "", { mode: 0o600 });
				const writer = Bun.file(path).writer({ highWaterMark: 1024 * 1024 });
				try {
					let pending = 0;
					while (remaining > 0) {
						await this.more();
						const chunk = this.buffer.subarray(
							this.offset,
							this.offset +
								Math.min(remaining, this.buffer.length - this.offset),
						);
						const written = writer.write(chunk);
						if (typeof written !== "number") await written;
						this.offset += chunk.length;
						remaining -= chunk.length;
						pending += chunk.length;
						if (pending >= 1024 * 1024) {
							await writer.flush();
							pending = 0;
						}
					}
				} finally {
					await writer.end();
				}
				continue;
			}
			if (isTaggedCompletion(line, tag)) {
				if (!/^A\d+ OK(?:\s|$)/i.test(line))
					throw new Error("IMAP fetch failed");
				if (!found) throw new Error("IMAP fetch returned no message");
				return;
			}
		}
	}
}
async function login(
	input: z.infer<typeof imapLoginSchema>,
	network?: ImapNetwork,
	signal?: AbortSignal,
) {
	const connection = new ImapConnection(
		await connectImap(input, network, signal),
	);
	try {
		await connection.greeting();
		await connection.command(
			`LOGIN ${quoteImapString(input.username)} ${quoteImapString(input.password)}`,
		);
		return connection;
	} catch (error) {
		connection.close();
		throw error;
	}
}
export async function listImapFolders(
	input: z.infer<typeof imapLoginSchema>,
	network?: ImapNetwork,
	signal?: AbortSignal,
) {
	const connection = await login(input, network, signal);
	try {
		const lines = await connection.command('LIST "" "*"');
		await connection.command("LOGOUT").catch(() => {});
		return [
			...new Set(
				lines
					.map(parseListMailboxName)
					.filter((value): value is string => !!value),
			),
		];
	} finally {
		connection.close();
	}
}
function uidBatch(lines: string[], limit: number, offset: number) {
	const searches = lines.filter((line) => /^\* SEARCH(?:\s|$)/i.test(line)),
		valid = /^\d+$/;
	let total = 0;
	for (const line of searches)
		for (const match of line.slice(8).matchAll(/\S+/g))
			if (valid.test(match[0])) total++;
	const end = Math.max(0, total - Math.min(offset, total)),
		start = Math.max(0, end - limit),
		uids: string[] = [];
	let index = 0;
	for (const line of searches)
		for (const match of line.slice(8).matchAll(/\S+/g)) {
			if (!valid.test(match[0])) continue;
			if (index >= start && index < end) uids.push(match[0]);
			index++;
		}
	return { uids, total, nextOffset: start > 0 ? offset + end - start : null };
}

export async function fetchImapBatch(
	input: ReturnType<typeof parseImapImport>,
	network?: ImapNetwork,
	signal?: AbortSignal,
) {
	const storage = new LocalStorage(),
		directory = storage.path(`import-staging/${id("imap")}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let connection: ImapConnection | undefined;
	try {
		connection = await login(input, network, signal);
		await connection.command(`SELECT ${quoteImapString(input.folder)}`);
		const batch = uidBatch(
				await connection.command("UID SEARCH ALL"),
				input.limit,
				input.offset,
			),
			files: { filename: string; path: string }[] = [];
		for (const uid of batch.uids) {
			const path = `${directory}/${uid}.eml`;
			await connection.fetchMessage(uid, path);
			files.push({ filename: `${input.folder}-${uid}.eml`, path });
		}
		await connection.command("LOGOUT").catch(() => {});
		return {
			total: batch.total,
			nextOffset: batch.nextOffset,
			async *messages(): AsyncGenerator<ImportMessageInput> {
				for (const file of files) {
					if (signal?.aborted) throw new Error("IMAP operation cancelled");
					yield {
						filename: file.filename,
						raw: await Bun.file(file.path).arrayBuffer(),
					};
				}
			},
			cleanup: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	} finally {
		connection?.close();
	}
}

export async function clearImapStaging() {
	await rm(new LocalStorage().path("import-staging"), {
		recursive: true,
		force: true,
	});
}
