import { resolve } from "node:path";
import { deepStrictEqual } from "node:assert";
import { fixture } from "../tests/fixtures";
import { hash } from "../src/server/auth/service";
import {
	readSamples,
	readApiKey,
	readExpectedBody,
	readPath,
	prepareReadFixture,
	normalizeReadBody,
} from "../tests/mail-read-fixture";
import capture from "../tests/source-mail-reads.json";

const state = await fixture(),
	binary = resolve(process.argv[2] ?? "dist/mailrun-local"),
	publicBase = "https://read-fixture.example";
const tokens = { owner: crypto.randomUUID(), stranger: crypto.randomUUID() };
for (const [actor, token] of Object.entries(tokens))
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)",
		)
		.run(
			`read-${actor}`,
			actor,
			await hash(token),
			Math.floor(Date.now() / 1000) + 900,
		);
const child = Bun.spawn([binary], {
	cwd: state.directory,
	env: {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		DATA_DIR: state.directory,
		PORT: "0",
		HOST: "127.0.0.1",
		APP_URL: publicBase,
		NODE_ENV: "production",
	},
	stdout: "pipe",
	stderr: "pipe",
});
const errors = new Response(child.stderr).text();
try {
	const reader = child.stdout.getReader();
	let base = "",
		timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				let text = "";
				while (!base) {
					const part = await reader.read();
					if (part.done) throw new Error("Read fixture exited during startup");
					text += new TextDecoder().decode(part.value);
					base = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
				}
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Read fixture did not boot")),
					15000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	let passed = 0;
	const failures: string[] = [];
	for (const sample of readSamples) {
		const expected = capture.cases.find((value) => value.name === sample.name);
		if (!expected) throw new Error("Missing original capture: " + sample.name);
		prepareReadFixture(state.db, sample);
		const response = await fetch(base + readPath(sample), {
			headers: {
				Authorization:
					"Bearer " +
					(sample.kind === "v1" ? readApiKey : tokens[sample.actor ?? "owner"]),
				...(sample.headerZone ? { "X-Time-Zone": sample.headerZone } : {}),
			},
			signal: AbortSignal.timeout(60000),
		});
		try {
			deepStrictEqual(
				response.status,
				expected.status,
				`Compiled HTTP status differs: ${sample.name}`,
			);
			deepStrictEqual(
				normalizeReadBody(await response.json()),
				readExpectedBody(sample, expected.body),
				`Compiled source contract differs: ${sample.name}`,
			);
		} catch {
			failures.push(sample.name);
			continue;
		}

		passed++;
	}

	if (process.argv.includes("--measure")) {
		prepareReadFixture(state.db, { name: "measurement", kind: "list" });
		state.db.exec(
			"DELETE FROM outbound_jobs; DELETE FROM messages; DELETE FROM contacts",
		);
		const insert = state.db.query(
			"INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,status,thread_id,read,created_at) VALUES(?,'owner','mailbox',?,'sender@example.org','Receiver <receiver@example.net>, Other <other@example.net>',?,'Synthetic preview','Searchable body',?,?,?,?)",
		);
		state.db.transaction(() => {
			for (let i = 0; i < 10000; i++)
				insert.run(
					`measure-${i}`,
					i % 10 === 9 ? "outbound" : "inbound",
					`Invoice ${i}`,
					i % 10 === 9 ? "sent" : "received",
					`thread-${Math.floor(i / 10)}`,
					i % 3 === 0 ? 1 : 0,
					1700000000 + i,
				);
			const contact = state.db.query(
				"INSERT INTO contacts(id,user_id,email,display_name,source,last_seen_at,created_at) VALUES(?,'owner',?,?,'manual',1,1)",
			);
			for (let i = 0; i < 1000; i++)
				contact.run(`contact-${i}`, `contact-${i}@example.org`, `Contact ${i}`);
		})();
		const measurements = [];
		for (const path of [
			"/api/messages?mailboxId=mailbox&status=received&group=thread&limit=25",
			"/api/messages?mailboxId=mailbox&q=Invoice&group=thread&limit=25",
			"/api/messages/counts?mailboxId=mailbox",
			"/api/messages/navigation?mailboxId=mailbox&folder=starred&group=thread",
			"/api/messages/navigation?mailboxId=mailbox&folder=inbox&group=thread",
		]) {
			const samples: number[] = [];
			for (let i = 0; i < 25; i++) {
				const started = performance.now();
				const response = await fetch(base + path, {
					headers: { Authorization: "Bearer " + tokens.owner },
					signal: AbortSignal.timeout(60000),
				});
				if (!response.ok) throw new Error("Measurement HTTP failure");
				await response.json();
				if (i >= 5) samples.push(performance.now() - started);
			}
			const sorted = [...samples].sort((a, b) => a - b);
			measurements.push({
				path,
				samples,
				median: ((sorted[9] ?? 0) + (sorted[10] ?? 0)) / 2,
				p95: sorted[18],
			});
		}
		console.log(
			JSON.stringify({
				binary,
				sha256: new Bun.CryptoHasher("sha256")
					.update(await Bun.file(binary).arrayBuffer())
					.digest("hex"),
				messages: 10000,
				contacts: 1000,
				warmups: 5,
				measured: 20,
				measurements,
			}),
		);
	}

	if (failures.length)
		throw new Error(
			JSON.stringify({ passed, failed: failures.length, cases: failures }),
		);

	console.log(
		JSON.stringify(
			{
				binary,
				originalContracts: passed - 1,
				nativeDraftBodyExceptions: 1,
				metadataAndConversationCounts: "passed",
				folderCountsAndUnreadNavigation: "passed",
				mailboxScopeAndContacts: "passed",
				externalEmail: 0,
			},
			null,
			2,
		),
	);
} finally {
	child.kill("SIGTERM");
	await child.exited;
	const log = await errors;
	await state.close();
	if (log) console.error(log);
}
