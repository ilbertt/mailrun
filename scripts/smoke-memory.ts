// The test driver stays outside the app's cgroup; all mailbox data is disposable.
import { resolve, join } from "node:path";
import { readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";

const { values } = parseArgs({
	options: {
		binary: { type: "string", default: "dist/mailrun" },
		image: { type: "string", default: "oven/bun:1.4.4-slim" },
		memory: { type: "string", default: "256" },
		jobs: { type: "string", default: "parallel" },
		output: { type: "string" },
	},
});
const args = z
	.object({
		binary: z.string(),
		image: z.string(),
		memory: z.coerce.number().int().min(64).max(1024),
		jobs: z.enum(["none", "parallel"]),
		output: z.string().optional(),
	})
	.parse(values);
const state = await fixture(),
	token = crypto.randomUUID();
state.db
	.query(
		"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('memory','owner',?,?,1)",
	)
	.run(await hash(token), Math.floor(Date.now() / 1000) + 3600);
state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
// A macOS SQLite connection cannot safely share a live Linux WAL over a bind mount.
state.db.close();
const digest = (value: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");
const reservation = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(null),
});
const port = reservation.port;
await reservation.stop(true);
const base = `http://127.0.0.1:${port}`,
	name = `mailrun-memory-${crypto.randomUUID()}`;
async function docker(...args: string[]) {
	const child = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code)
		throw new Error(`docker ${args[0]} failed (${code}): ${err.slice(-1500)}`);
	return out.trim();
}
const samples: {
	phase: string;
	currentMiB: number;
	peakMiB: number;
	events: string;
}[] = [];
const messageIds: string[] = [];
async function sample(phase: string) {
	const text = await docker(
		"exec",
		name,
		"/bin/sh",
		"-c",
		"cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events",
	);
	const [current, peak, ...events] = text.split("\n");
	const value = {
		phase,
		currentMiB: Math.round(Number(current) / 1048576),
		peakMiB: Math.round(Number(peak) / 1048576),
		events: events.join("\n"),
	};
	samples.push(value);
	console.log(JSON.stringify(value));
	if (/^oom(?:_kill)? [1-9]/m.test(value.events))
		throw new Error("The constrained app encountered an OOM event");
}
const headers = {
	Cookie: `ep_session=${token}`,
	Origin: base,
	"Content-Type": "application/json",
};
let started = false;
try {
	await docker(
		"run",
		"--detach",
		"--name",
		name,
		"--cpus",
		"1",
		"--memory",
		`${args.memory}m`,
		"--memory-swap",
		`${args.memory}m`,
		"--pids-limit",
		"64",
		"--publish",
		`127.0.0.1:${port}:3000`,
		"--mount",
		`type=bind,source=${state.directory},target=/app/data`,
		"--mount",
		`type=bind,source=${resolve(args.binary)},target=/mnt/artifact/server,readonly`,
		"--env",
		"DATA_DIR=/app/data",
		"--env",
		"PORT=3000",
		"--env",
		"HOST=0.0.0.0",
		"--env",
		`APP_URL=${base}`,
		"--entrypoint",
		"/mnt/artifact/server",
		args.image,
	);
	started = true;
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const result = await fetch(base + "/api/auth/me", {
				headers,
				signal: AbortSignal.timeout(1000),
			});
			ready = result.ok;
			await result.body?.cancel();
			if (ready) break;
		} catch {
			/* Container is still starting. */
		}
		await Bun.sleep(100);
	}
	if (!ready) throw new Error("Constrained app did not become ready");
	await sample("cold");
	const keyResponse = await fetch(base + "/api/api-keys", {
		method: "POST",
		headers,
		body: JSON.stringify({
			name: "Constrained synthetic send",
			scopes: ["read", "send"],
			mailboxIds: ["mailbox"],
		}),
	});
	const key = z.object({ key: z.string() }).parse(await keyResponse.json()).key;
	if (!keyResponse.ok)
		throw new Error("Could not create the synthetic mail key");
	for (const route of [
		"/login",
		"/inbox",
		"/admin",
		"/domains",
		"/settings",
		"/drive",
		"/calendar",
	])
		await (await fetch(base + route, { headers })).arrayBuffer();
	const client = resolve("dist/client");
	async function warm(directory: string) {
		for (const item of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, item.name);
			if (item.isDirectory()) await warm(path);
			else if (/\.(?:js|css|woff2)$/.test(path)) {
				const response = await fetch(
					base + path.slice(client.length).replaceAll("\\", "/"),
				);
				if (!response.ok) throw new Error("An embedded asset failed to load");
				await response.arrayBuffer();
			}
		}
	}
	await warm(client);
	await sample("warm-documents-and-assets");
	for (let round = 0; round < 3; round++) {
		const files = [0, 1, 2].map((index) =>
			Buffer.alloc(8_000_000, index + round),
		);
		const body = JSON.stringify({
			mailboxId: "mailbox",
			from: "hello@example.com",
			to: "recipient@example.org",
			subject: `Constrained send ${round}`,
			text: "Synthetic future delivery; never dispatched to a provider",
			scheduledAt: "2099-01-01T00:00:00Z",
			attachments: files.map((bytes, index) => ({
				filename: `bulk-${index}.bin`,
				contentBase64: bytes.toString("base64"),
			})),
		});
		const maintenance =
			args.jobs === "none"
				? Promise.resolve("")
				: docker("exec", name, "/mnt/artifact/server", "jobs", "maintenance");
		const scheduled =
			args.jobs === "none"
				? Promise.resolve("")
				: docker("exec", name, "/mnt/artifact/server", "jobs", "scheduled");
		const jobs = Promise.allSettled([maintenance, scheduled]);
		const response = await fetch(base + "/api/v1/send", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body,
		});
		const result = await response.text();
		if (!response.ok)
			throw new Error(
				`Constrained send failed (${response.status}): ${result.slice(0, 300)}`,
			);
		const message = z
			.object({ messageId: z.string(), scheduled: z.literal(true) })
			.parse(JSON.parse(result));
		for (const job of await jobs) {
			if (job.status === "rejected") throw job.reason;
		}
		messageIds.push(message.messageId);
		const directory = join(
			state.directory,
			"blobs",
			"attachments",
			message.messageId,
		);
		const attachments = await readdir(directory);
		if (attachments.length !== 3)
			throw new Error("The scheduled attachments were not committed");
		const expected = files.map(digest).sort(),
			actualHashes: string[] = [];
		for (const attachment of attachments) {
			const actual = await Bun.file(join(directory, attachment)).arrayBuffer();
			if (actual.byteLength !== 8_000_000)
				throw new Error(
					"A constrained attachment differs from the original bytes",
				);
			actualHashes.push(digest(new Uint8Array(actual)));
		}
		if (JSON.stringify(expected) !== JSON.stringify(actualHashes.sort()))
			throw new Error("Attachment hashes differ");
		await sample(
			`large-send-${round + 1}-${args.jobs === "none" ? "alone" : "with-crons"}`,
		);
	}
	for (const messageId of messageIds) {
		const response = await fetch(base + `/api/messages/${messageId}/metadata`, {
			headers,
		});
		const metadata = z
			.object({
				attachments: z
					.array(z.object({ size: z.literal(8_000_000) }))
					.length(3),
			})
			.parse(await response.json());
		if (
			!response.ok ||
			metadata.attachments.reduce((sum, file) => sum + file.size, 0) !==
				24_000_000
		)
			throw new Error("Constrained attachment metadata differs");
	}
	await sample("metadata-verification");
	await docker("stop", "--time", "5", name);
	const binaryHash = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(resolve(args.binary)).stream())
		binaryHash.update(chunk);
	const result = {
		binarySha256: binaryHash.digest("hex"),
		memoryLimitMiB: args.memory,
		cpus: 1,
		cronMode: args.jobs,
		largeSends: 3,
		attachmentBytesPerSend: 24_000_000,
		samples,
		externalEmail: 0,
	};
	if (args.output)
		await Bun.write(
			resolve(args.output),
			JSON.stringify(result, null, 2) + "\n",
		);
	console.log(
		JSON.stringify({ constrainedServer: "passed", ...result }, null, 2),
	);
} catch (error) {
	if (started) {
		console.error(
			await docker("inspect", "--format", "{{json .State}}", name).catch(
				String,
			),
		);
		console.error(await docker("logs", "--tail", "15", name).catch(String));
	}
	throw error;
} finally {
	if (started) await docker("rm", "--force", name);
	await state.close();
}
