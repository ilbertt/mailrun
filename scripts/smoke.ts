import { writeAvatarFixturePreload } from "../tests/avatar-provider";
import { open, truncate } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "../tests/fixtures";
import { seconds } from "../src/server/db";
import { hash } from "../src/server/auth/service";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signRelay } from "../src/shared/relay-signature";
import { createHmac } from "node:crypto";
import { LocalStorage } from "../src/server/storage";
import { sourceRouteContracts } from "../src/server/http/route-contract";
import sourceHttpMethods from "../tests/source-http-methods.json";

const state = await fixture();
const token = crypto.randomUUID();
const password = crypto.randomUUID();
state.db
	.query("UPDATE users SET password_hash=? WHERE id='owner'")
	.run(await bcrypt.hash(password, 4));
state.db
	.query(
		"INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES ('smoke','owner',?,?,?)",
	)
	.run(await hash(token), seconds() + 300, seconds());
const binary = resolve(process.argv[2] ?? "dist/mailrun-local");
const oldImportStage = "import-staging/previous-session/stale.eml";
await new LocalStorage().put(oldImportStage, "synthetic abandoned import");
const publicBase = "https://mailrun-smoke.example";
const avatarPreload = await writeAvatarFixturePreload(state.directory);
const smokeEnvironment: Record<string, string | undefined> = {
	BUN_OPTIONS: "--preload " + avatarPreload.path,
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	PORT: "0",
	HOST: "127.0.0.1",
	APP_URL: publicBase,
	NODE_ENV: "production",
};
const webhookRequests: { headers: Headers; body: string }[] = [];
let webhookStatus = 503;
const webhookReceiver = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		webhookRequests.push({
			headers: request.headers,
			body: await request.text(),
		});
		return new Response(
			webhookStatus === 204 ? null : "Synthetic endpoint unavailable",
			{ status: webhookStatus },
		);
	},
});
const child = Bun.spawn([binary], {
	cwd: state.directory,
	env: smokeEnvironment,
	stdout: "pipe",
	stderr: "pipe",
});
try {
	const reader = child.stdout.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const first = await Promise.race([
		reader.read(),
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Server did not boot within 10 seconds")),
				10_000,
			);
		}),
	]);
	clearTimeout(timer);
	const log = new TextDecoder().decode(first.value);
	const base = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
	if (!base) throw new Error(`Unexpected startup output: ${log}`);
	reader.releaseLock();
	// These responses were captured from the real original server, independently
	// of our method table. Keep authentication absent in both fixtures.
	for (const sample of sourceHttpMethods.cases) {
		const response = await fetch(base + sample.path, {
			method: sample.method,
			redirect: "manual",
		});
		if (
			response.status !== sample.status ||
			response.headers.get("Allow") !== sample.allow ||
			response.headers.get("Location") !== sample.location ||
			response.headers.get("Refresh") !== sample.refresh ||
			(await response.arrayBuffer()).byteLength !== sample.bytes
		)
			throw new Error(
				`Original HTTP response differs: ${sample.method} ${sample.path}`,
			);
	}
	// Exercise the compiled boundary, including routes still awaiting a provider
	// port. Method compatibility does not assert their allowed handlers exist.
	for (const { path, methods } of sourceRouteContracts) {
		const sample = path
			.replace(/\[\[\.\.\.[^\]]+\]\]/g, "session")
			.replace(/\[[^\]]+\]/g, "fixture");
		if (!methods.includes("OPTIONS")) {
			const options = await fetch(base + sample, { method: "OPTIONS" });
			const allowed = [
				...methods,
				"OPTIONS",
				...(methods.includes("GET") && !methods.includes("HEAD")
					? ["HEAD"]
					: []),
			]
				.sort()
				.join(", ");
			if (
				options.status !== 204 ||
				options.headers.get("Allow") !== allowed ||
				(await options.text())
			)
				throw new Error(`Source OPTIONS contract failed for ${path}`);
		}
		const unsupported = ["PUT", "DELETE", "PATCH", "POST", "GET"].find(
			(method) => !methods.includes(method),
		);
		if (unsupported) {
			const result = await fetch(base + sample, {
				method: unsupported,
				headers: { Origin: "https://foreign.example" },
			});
			if (result.status !== 405 || (await result.text()))
				throw new Error(`Source ${unsupported} contract failed for ${path}`);
		}
	}
	const publicHome = await fetch(base + "/", { redirect: "manual" });
	const publicHomeHtml = await publicHome.text();
	if (
		publicHome.status !== 200 ||
		!publicHomeHtml.includes("Mailboxes that feel like your inbox.") ||
		!publicHomeHtml.includes('href="/login"') ||
		!publicHomeHtml.includes('href="/setup"')
	)
		throw new Error("Original public homepage was not rendered");
	for (const [path, title] of [
		["/login", "Sign in"],
		["/login?add=1", "Sign in"],
		["/forgot-password", "Reset your password"],
		["/reset-password?token=synthetic", "Choose a new password"],
		["/reset-password?token=1", "Choose a new password"],
	] as const) {
		const response = await fetch(base + path);
		const html = await response.text();
		if (
			!response.ok ||
			[...html.matchAll(/<title>([^<]*)<\/title>/g)]
				.map((match) => match[1])
				.join() !== `${title} - Mailflare`
		)
			throw new Error(`Original auth title missing from SSR: ${path}`);
	}
	const csrf = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "https://untrusted.example",
		},
		body: JSON.stringify({ email: "owner@example.com", password }),
	});
	if (csrf.status !== 403)
		throw new Error(`Cross-origin login returned ${csrf.status}`);
	const login = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: publicBase },
		body: JSON.stringify({ email: "owner@example.com", password }),
	});
	const cookie = login.headers
		.getSetCookie()
		.find((value) => value.startsWith("ep_session="));
	if (!login.ok || !cookie?.toLowerCase().includes("httponly"))
		throw new Error(`HTTP login failed: ${login.status}`);
	const sessionCookie = cookie.split(";")[0] ?? "";
	const addAccount = await fetch(base + "/login?add=1", {
		headers: { Cookie: sessionCookie },
		redirect: "manual",
	});
	if (
		addAccount.status !== 200 ||
		!(await addAccount.text()).includes("Add another account")
	)
		throw new Error(
			"The source add-account flag failed for a signed-in account",
		);
	for (const path of [
		"/api/auth/me",
		"/api/messages?mailboxId=mailbox",
		"/api/admin/migrations",
		"/api/branding",
		"/api/branding/icon",
	]) {
		const head = await fetch(base + path, {
			method: "HEAD",
			headers: { Cookie: sessionCookie },
		});
		const get = await fetch(base + path, {
			headers: { Cookie: sessionCookie },
		});
		await get.body?.cancel();
		if (
			head.status !== get.status ||
			head.headers.get("Content-Type") !== get.headers.get("Content-Type") ||
			(await head.text())
		)
			throw new Error(`Source HEAD contract failed for ${path}`);
	}
	const mailResponse = await fetch(
		`${base}/api/messages?mailboxId=mailbox&status=received`,
		{ headers: { Cookie: sessionCookie } },
	);
	const mail = await mailResponse.json();
	if (
		!mailResponse.ok ||
		!z
			.object({
				messages: z.array(
					z.object({ id: z.string(), subject: z.string().nullable() }),
				),
			})
			.parse(mail)
			.messages.some((message) => message.subject === "A searchable subject")
	)
		throw new Error("Source-compatible message list failed");
	const calendarHeaders = {
		Cookie: sessionCookie,
		Origin: publicBase,
		"Content-Type": "application/json",
	};
	const updateStatus = await fetch(`${base}/api/admin/update`, {
		headers: calendarHeaders,
	});
	if (
		!updateStatus.ok ||
		z
			.object({
				configured: z.literal(false),
				configuration: z.array(z.unknown()),
			})
			.parse(await updateStatus.json()).configuration.length
	)
		throw new Error("Self-hosted update status failed");
	const migrationStatus = await fetch(`${base}/api/admin/migrations`, {
		method: "POST",
		headers: calendarHeaders,
	});
	if (
		!migrationStatus.ok ||
		!z.object({ ready: z.boolean() }).parse(await migrationStatus.json()).ready
	)
		throw new Error("Compiled migration status/application failed");
	const missingMigrationOrigin = await fetch(`${base}/api/admin/migrations`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});
	if (missingMigrationOrigin.status !== 403)
		throw new Error("Migration application accepted a missing origin");
	const rebuilt = await fetch(`${base}/api/admin/search-index`, {
		method: "POST",
		headers: calendarHeaders,
	});
	if (
		!rebuilt.ok ||
		!z
			.object({ indexed: z.number(), messages: z.number() })
			.parse(await rebuilt.json()).messages
	)
		throw new Error("Compiled search-index rebuild failed");

	const hookResponse = await fetch(`${base}/api/webhooks`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			url: webhookReceiver.url.href,
			description: "Standalone synthetic endpoint",
			events: ["message.inbound", "message.outbound", "message.failed"],
			maxAttempts: 3,
		}),
	});
	const hook = z
		.object({ id: z.string(), secret: z.string() })
		.parse(await hookResponse.json());
	if (!hookResponse.ok) throw new Error("Webhook creation failed");
	const hookTest = await fetch(`${base}/api/webhooks/${hook.id}/test`, {
		method: "POST",
		headers: calendarHeaders,
	});
	const testDelivery = z
		.object({ deliveryId: z.string(), status: z.literal("retrying") })
		.parse(await hookTest.json());
	if (!hookTest.ok || webhookRequests.length !== 1)
		throw new Error("Webhook test did not record failure");
	webhookStatus = 204;
	const hookRetry = await fetch(
		`${base}/api/webhooks/${hook.id}/deliveries/${testDelivery.deliveryId}/retry`,
		{ method: "POST", headers: calendarHeaders },
	);
	if (
		!hookRetry.ok ||
		!z
			.object({ status: z.literal("delivered") })
			.safeParse(await hookRetry.json()).success
	)
		throw new Error("Manual webhook retry failed");
	const rotatedHook = await fetch(`${base}/api/webhooks/${hook.id}`, {
		method: "PATCH",
		headers: calendarHeaders,
		body: JSON.stringify({ rotateSecret: true }),
	});
	const rotatedSecret = z
		.object({ secret: z.string() })
		.parse(await rotatedHook.json()).secret;
	if (!rotatedHook.ok || rotatedSecret === hook.secret)
		throw new Error("Webhook secret rotation failed");
	const hookList = await fetch(`${base}/api/webhooks`, {
		headers: { Cookie: sessionCookie },
	});
	const hookListText = await hookList.text();
	if (
		!hookList.ok ||
		hookListText.includes(hook.secret) ||
		hookListText.includes(rotatedSecret)
	)
		throw new Error("Webhook inventory exposed a secret");

	state.db.exec(
		"INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','http-smoke','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'",
	);
	const brandedName = "Parcelroom";
	const brandingForm = new FormData();
	brandingForm.set("appName", brandedName);
	const savedBranding = await fetch(base + "/api/branding", {
		method: "PUT",
		headers: { Cookie: sessionCookie, Origin: publicBase },
		body: brandingForm,
	});
	if (!savedBranding.ok) throw new Error("Could not save entitled branding");
	for (const [path, title, text] of [
		["/", brandedName, "Mailboxes that feel like your inbox."],
		["/login", `Sign in - ${brandedName}`, "Open your mailbox"],
		[
			"/forgot-password",
			`Reset your password - ${brandedName}`,
			"Reset your password",
		],
		[
			"/reset-password?token=synthetic",
			`Choose a new password - ${brandedName}`,
			"Choose a new password",
		],
	] as const) {
		const response = await fetch(base + path);
		const html = await response.text();
		if (
			!response.ok ||
			[...html.matchAll(/<title>([^<]*)<\/title>/g)]
				.map((match) => match[1])
				.join() !== title ||
			!html.includes(text)
		)
			throw new Error(`Initial branded document differs: ${path}`);
		for (const expected of [
			`name="apple-mobile-web-app-title" content="${brandedName}"`,
			'name="description" content="Multi-tenant email on Cloudflare"',
			'name="mobile-web-app-capable" content="yes"',
			'name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex"',
		])
			if (!html.includes(expected))
				throw new Error(`Document metadata missing: ${path}: ${expected}`);
	}
	const italianLogin = await fetch(base + "/login", {
		headers: { Cookie: "mailflare-locale=it" },
	});
	const italianHtml = await italianLogin.text();
	if (
		!italianLogin.ok ||
		!italianHtml.includes(`<title>Accedi - ${brandedName}</title>`) ||
		!italianHtml.includes('lang="it"')
	)
		throw new Error("Localized auth metadata missing from the first render");
	const restoredBranding = new FormData();
	restoredBranding.set("appName", "Mailflare");
	if (
		!(
			await fetch(base + "/api/branding", {
				method: "PUT",
				headers: { Cookie: sessionCookie, Origin: publicBase },
				body: restoredBranding,
			})
		).ok
	)
		throw new Error("Could not restore fixture branding");
	const accountPassword = crypto.randomUUID(),
		createdAccount = await fetch(`${base}/api/accounts`, {
			method: "POST",
			headers: calendarHeaders,
			body: JSON.stringify({
				username: "standalone-account",
				domainId: "domain",
				password: accountPassword,
				aliases: [{ domainId: "domain", localPart: "standalone-alias" }],
			}),
		});
	const managed = z
		.object({ account: z.object({ id: z.string(), email: z.string() }) })
		.parse(await createdAccount.json()).account;
	if (createdAccount.status !== 201) throw new Error("Account creation failed");
	const domainList = await fetch(`${base}/api/domains`, {
		headers: { Cookie: sessionCookie },
	});
	if (
		!domainList.ok ||
		!z
			.object({
				domains: z.array(
					z.object({ id: z.string(), sendingProvider: z.string() }),
				),
			})
			.parse(await domainList.json())
			.domains.some((domain) => domain.id === "domain")
	)
		throw new Error("Original domain list contract failed");
	const accountDetails = await fetch(`${base}/api/accounts/${managed.id}`, {
		headers: { Cookie: sessionCookie },
	});
	if (
		!accountDetails.ok ||
		!z
			.object({
				account: z.object({
					editable: z.literal(true),
					canChangeRole: z.literal(true),
				}),
			})
			.safeParse(await accountDetails.json()).success
	)
		throw new Error("Managed account details failed");
	const managedLogin = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({ email: managed.email, password: accountPassword }),
	});
	const managedCookie = managedLogin.headers
		.getSetCookie()
		.find((value) => value.startsWith("ep_session="))
		?.split(";")[0];
	if (!managedLogin.ok || !managedCookie)
		throw new Error("Created account could not sign in");
	const reset = await fetch(`${base}/api/accounts/${managed.id}`, {
		method: "PATCH",
		headers: calendarHeaders,
		body: JSON.stringify({
			name: "Standalone account",
			role: "user",
			disabled: false,
			canManageMailboxes: false,
			password: crypto.randomUUID(),
		}),
	});
	if (
		!reset.ok ||
		(
			await fetch(`${base}/api/drive/items`, {
				headers: { Cookie: managedCookie },
			})
		).status !== 401
	)
		throw new Error("Administrative password reset did not revoke sessions");
	for (const route of [
		"/admin",
		"/accounts",
		`/accounts/${managed.id}`,
		`/accounts/${managed.id}/permissions`,
		`/accounts/${managed.id}/password`,
		`/accounts/${managed.id}/mailboxes`,
		"/mailboxes",
		"/mailboxes/mailbox",
		"/domains",
	]) {
		const page = await fetch(base + route, {
			headers: { Cookie: sessionCookie },
		});
		if (!page.ok)
			throw new Error(`Original admin route failed: ${route} (${page.status})`);
	}

	for (const sample of [
		{
			headers: new Headers({
				Cookie: sessionCookie,
				Origin: "https://untrusted.example",
			}),
			status: 403,
		},
		{ headers: new Headers({ Cookie: sessionCookie }), status: 403 },
		{ headers: new Headers({ Authorization: "Bearer invalid" }), status: 401 },
	]) {
		const response = await fetch(`${base}/api/drive/upload`, {
			method: "POST",
			headers: sample.headers,
			body: JSON.stringify({ name: "Unauthorized", size: 0 }),
		});
		if (response.status !== sample.status)
			throw new Error(
				`Native upload authentication/origin check returned ${response.status}`,
			);
	}

	if (await new LocalStorage().file(oldImportStage).exists())
		throw new Error("Abandoned IMAP staging was not cleared on startup");
	for (const sample of [
		{
			path: "/api/export/messages?mailboxId=mailbox",
			method: "GET",
			headers: new Headers(),
			status: 401,
		},
		{
			path: "/api/import/messages",
			method: "POST",
			headers: new Headers({ Origin: publicBase }),
			status: 401,
		},
		{
			path: "/api/import/messages",
			method: "POST",
			headers: new Headers({
				Cookie: sessionCookie,
				Origin: "https://untrusted.example",
			}),
			status: 403,
		},
	]) {
		const response = await fetch(base + sample.path, {
			method: sample.method,
			headers: sample.headers,
		});
		if (response.status !== sample.status)
			throw new Error(
				`Native mail transfer auth/origin check returned ${response.status}`,
			);
	}
	const oversizedImport = await fetch(`${base}/api/import/messages`, {
		method: "POST",
		headers: { Cookie: sessionCookie, Origin: publicBase },
		body: new Blob([new Uint8Array(31 * 1024 * 1024)]),
	});
	if (
		oversizedImport.status !== 413 ||
		!z.object({ error: z.string() }).safeParse(await oversizedImport.json())
			.success
	)
		throw new Error("Oversized import did not return the JSON error contract");
	const importedRaw =
		"From: Importer <importer@example.org>\r\nTo: hello@example.com\r\nSubject: Standalone import\r\nMessage-ID: <standalone-import@example.org>\r\nDate: Wed, 15 Jan 2025 12:34:56 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=part\r\n\r\n--part\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nStandalone imported body\r\n--part\r\nContent-Type: text/plain; name=note.txt\r\nContent-Disposition: attachment; filename=note.txt\r\nContent-Transfer-Encoding: base64\r\n\r\naW1wb3J0IGF0dGFjaG1lbnQ=\r\n--part--\r\n";
	const importForm = () => {
		const form = new FormData();
		form.set("mailboxId", "mailbox");
		form.set("destination", "system:inbox");
		form.append(
			"files",
			new File([importedRaw], "standalone.eml", { type: "message/rfc822" }),
		);
		return form;
	};
	const importedResponse = await fetch(`${base}/api/import/messages`, {
		method: "POST",
		headers: { Cookie: sessionCookie, Origin: publicBase },
		body: importForm(),
	});
	if (
		!importedResponse.ok ||
		!z
			.object({ imported: z.literal(1), skipped: z.literal(0) })
			.safeParse(await importedResponse.json()).success
	)
		throw new Error("Standalone EML import failed");
	const duplicateImport = await fetch(`${base}/api/import/messages`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: importForm(),
	});
	if (
		!duplicateImport.ok ||
		!z
			.object({ imported: z.literal(0), skipped: z.literal(1) })
			.safeParse(await duplicateImport.json()).success
	)
		throw new Error("EML replay was not deduplicated");
	const importedMessage = state.db
		.query<{ id: string }, []>(
			"SELECT id FROM messages WHERE provider_message_id='<standalone-import@example.org>'",
		)
		.get();
	if (!importedMessage) throw new Error("Imported message was not committed");
	const importedAttachment = state.db
		.query<{ id: string }, [string]>(
			"SELECT id FROM message_attachments WHERE message_id=?",
		)
		.get(importedMessage.id);
	if (!importedAttachment)
		throw new Error("Imported attachment was not committed");
	const importedDownload = await fetch(
		`${base}/api/messages/${importedMessage.id}/attachments/${importedAttachment.id}`,
		{ headers: { Cookie: sessionCookie } },
	);
	if (
		!importedDownload.ok ||
		(await importedDownload.text()) !== "import attachment"
	)
		throw new Error("Imported attachment download failed");
	const exportResponse = await fetch(
		`${base}/api/export/messages?mailboxId=mailbox`,
		{ headers: { Cookie: sessionCookie } },
	);
	const exportedMbox = await exportResponse.text();
	if (
		!exportResponse.ok ||
		!exportResponse.headers.get("content-type")?.includes("application/mbox") ||
		!exportedMbox.includes("Standalone imported body")
	)
		throw new Error("Streamed MBOX export failed");
	const exportHead = await fetch(
		`${base}/api/export/messages?mailboxId=mailbox`,
		{ method: "HEAD", headers: { Cookie: sessionCookie } },
	);
	if (
		!exportHead.ok ||
		(await exportHead.text()) !== "" ||
		exportHead.headers.get("content-disposition") !==
			exportResponse.headers.get("content-disposition")
	)
		throw new Error("MBOX HEAD contract failed");
	const privateImap = await fetch(`${base}/api/import/imap/folders`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			host: "127.0.0.1",
			port: 993,
			username: "synthetic",
			password: "synthetic",
		}),
	});
	if (privateImap.status !== 502)
		throw new Error("Private IMAP target was not rejected");
	for (const route of ["/settings/import-export", "/import-export"]) {
		const response = await fetch(base + route, {
			headers: { Cookie: sessionCookie },
			redirect: "manual",
		});
		if (
			![302, 307].includes(response.status) ||
			!response.headers.get("location")?.includes("/settings/import")
		)
			throw new Error(`Import URL alias failed: ${route}`);
	}
	const publicMailKeyResponse = await fetch(`${base}/api/api-keys`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			name: "Public mail client",
			scopes: ["read", "send"],
			mailboxIds: ["mailbox"],
		}),
	});
	const publicMailKey = z
		.object({ id: z.string(), key: z.string() })
		.parse(await publicMailKeyResponse.json());
	if (!publicMailKeyResponse.ok)
		throw new Error("Public mail key creation failed");
	const jmapKeyResponse = await fetch(`${base}/api/api-keys`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			name: "JMAP mail client",
			scopes: ["jmap"],
			mailboxIds: ["mailbox"],
		}),
	});
	const jmapKey = z
		.object({ key: z.string() })
		.parse(await jmapKeyResponse.json());
	const jmapHeaders = {
		Authorization: `Basic ${btoa("client:" + jmapKey.key)}`,
	};
	const discovery = await fetch(`${base}/.well-known/jmap`, {
		redirect: "manual",
	});
	if (
		discovery.status !== 301 ||
		discovery.headers.get("location") !== `${publicBase}/jmap/session`
	)
		throw new Error("JMAP source discovery URL failed");
	const jmapSession = await fetch(`${base}/jmap/session`, {
		headers: jmapHeaders,
	});
	if (
		!jmapSession.ok ||
		!z
			.object({
				username: z.literal("owner@example.com"),
				apiUrl: z.literal(`${publicBase}/jmap/api`),
			})
			.safeParse(await jmapSession.json()).success
	)
		throw new Error("JMAP authenticated session contract failed");
	if (
		(
			await fetch(`${base}/jmap/session`, {
				headers: { Cookie: sessionCookie },
			})
		).status !== 401 ||
		(
			await fetch(`${base}/jmap/session`, {
				headers: { Authorization: `Bearer ${publicMailKey.key}` },
			})
		).status !== 403
	)
		throw new Error("JMAP key scope/session isolation failed");
	const jmapCall = async (
		methodCalls: [string, Record<string, unknown>, string][],
	) => {
		const response = await fetch(`${base}/jmap/api`, {
			method: "POST",
			headers: { ...jmapHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
				methodCalls,
			}),
		});
		if (!response.ok)
			throw new Error(`JMAP method request failed: ${response.status}`);
		return z
			.object({
				methodResponses: z.array(
					z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
				),
			})
			.parse(await response.json());
	};
	const jmapQuery = await jmapCall([
		["Email/query", { filter: { subject: "searchable" } }, "q"],
		[
			"Email/get",
			{
				"#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
				properties: ["id", "subject", "bodyValues"],
				fetchTextBodyValues: true,
			},
			"g",
		],
		["Email/changes", { sinceState: "old" }, "c"],
	]);
	if (
		!z
			.object({ ids: z.array(z.string()) })
			.parse(jmapQuery.methodResponses[0]?.[1])
			.ids.includes("message") ||
		!z
			.object({ list: z.array(z.object({ id: z.string() })) })
			.parse(jmapQuery.methodResponses[1]?.[1])
			.list.some((row) => row.id === "message") ||
		jmapQuery.methodResponses[2]?.[0] !== "error" ||
		jmapQuery.methodResponses[2]?.[1].type !== "cannotCalculateChanges"
	)
		throw new Error("JMAP query/reference/history contract failed");
	const jmapMime =
		"From: hello@example.com\r\nTo: recipient@example.org\r\nSubject: JMAP smoke draft\r\nContent-Type: text/plain\r\n\r\nCompiled JMAP MIME";
	const jmapUploadResponse = await fetch(`${base}/jmap/upload/owner`, {
		method: "POST",
		headers: { ...jmapHeaders, "Content-Type": "message/rfc822" },
		body: jmapMime,
	});
	if (jmapUploadResponse.status !== 201) throw new Error("JMAP upload failed");
	const jmapUpload = z
		.object({ blobId: z.string() })
		.parse(await jmapUploadResponse.json());
	const jmapImport = await jmapCall([
		[
			"Email/import",
			{
				emails: {
					draft: {
						blobId: jmapUpload.blobId,
						mailboxIds: { "mailbox~drafts": true },
					},
				},
			},
			"i",
		],
	]);
	const jmapImported = z
		.object({
			created: z.object({
				draft: z.object({ id: z.string(), blobId: z.string() }),
			}),
		})
		.parse(jmapImport.methodResponses[0]?.[1]).created.draft;
	const jmapDownload = await fetch(
		`${base}/jmap/download/owner/${jmapImported.blobId}/draft.eml`,
		{ headers: jmapHeaders },
	);
	if (!jmapDownload.ok || (await jmapDownload.text()) !== jmapMime)
		throw new Error("JMAP imported MIME download differs");
	const jmapEvents = await fetch(`${base}/jmap/eventsource?closeafter=state`, {
		headers: jmapHeaders,
	});
	if (
		!jmapEvents.ok ||
		!(await jmapEvents.text()).includes('"@type":"StateChange"')
	)
		throw new Error("JMAP state event stream failed");
	await jmapCall([["Email/set", { destroy: [jmapImported.id] }, "d"]]);
	const mcpKeyResponse = await fetch(`${base}/api/agent/mcp-keys`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			name: "MCP smoke",
			scopes: [
				"mcp:read",
				"mcp:draft",
				"mcp:request-send",
				"mcp:calendar-read",
			],
			mailboxIds: ["mailbox"],
		}),
	});
	const mcpKey = z
		.object({ key: z.string() })
		.parse(await mcpKeyResponse.json());
	const mcpHeaders = {
		Authorization: `Bearer ${mcpKey.key}`,
		Host: new URL(publicBase).host,
		Accept: "application/json, text/event-stream",
		Origin: publicBase,
		"Content-Type": "application/json",
	};
	const mcpCall = async (
		method: string,
		params: Record<string, unknown>,
		extra: Record<string, string> = {},
	) => {
		const response = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: { ...mcpHeaders, ...extra },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		if (!response.ok)
			throw new Error(`Compiled MCP request failed: ${response.status}`);
		const text = await response.text(),
			wire = response.headers.get("content-type")?.includes("text/event-stream")
				? JSON.parse(
						text
							.split("\n")
							.find((line) => line.startsWith("data: "))!
							.slice(6),
					)
				: JSON.parse(text);
		return z.object({ result: z.record(z.string(), z.unknown()) }).parse(wire)
			.result;
	};
	const mcpTool = async (name: string, args: Record<string, unknown>) => {
		const result = await mcpCall("tools/call", { name, arguments: args }),
			parsed = z
				.object({
					content: z.array(z.object({ text: z.string() })),
					isError: z.boolean().optional(),
				})
				.parse(result);
		if (parsed.isError)
			throw new Error(`Compiled MCP tool failed: ${parsed.content[0]?.text}`);
		return JSON.parse(parsed.content[0]!.text) as unknown;
	};
	const mcpOptions = await fetch(`${base}/mcp`, {
		method: "OPTIONS",
		headers: { Host: new URL(publicBase).host },
	});
	const mcpHead = await fetch(`${base}/mcp`, {
		method: "HEAD",
		headers: mcpHeaders,
	});
	if (
		mcpOptions.status !== 204 ||
		!mcpOptions.headers.get("allow")?.includes("HEAD") ||
		mcpHead.status !== 405 ||
		(await mcpHead.text()) !== ""
	)
		throw new Error("Compiled MCP HEAD/OPTIONS contract failed");
	const mcpInit = await mcpCall("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "fixture", version: "1" },
	});
	if (
		!z
			.object({ serverInfo: z.object({ name: z.literal("mailflare") }) })
			.safeParse(mcpInit).success
	)
		throw new Error("Compiled MCP initialization failed");
	const mcpModern = await mcpCall(
		"server/discover",
		{
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": {
					name: "compiled-fixture",
					version: "1",
				},
			},
		},
		{ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" },
	);
	if (
		!z
			.object({ supportedVersions: z.array(z.string()) })
			.parse(mcpModern)
			.supportedVersions.includes("2026-07-28")
	)
		throw new Error("Compiled modern MCP discovery failed");
	const mcpBoxes = z
		.array(z.object({ id: z.string() }))
		.parse(await mcpTool("list_mailboxes", {}));
	if (!mcpBoxes.some((row) => row.id === "mailbox"))
		throw new Error("Compiled MCP mailbox scope failed");
	const mcpPage = z
		.object({
			emails: z.array(
				z.object({
					id: z.string(),
					from: z.string(),
					to: z.string(),
					createdAt: z.string(),
					read: z.boolean(),
					starred: z.boolean(),
				}),
			),
			nextCursor: z.string().nullable(),
		})
		.parse(await mcpTool("list_emails", { mailboxId: "mailbox", limit: 1 }));
	if (!mcpPage.emails.length)
		throw new Error("Compiled MCP metadata projection failed");
	if (mcpPage.nextCursor)
		await mcpTool("list_emails", {
			mailboxId: "mailbox",
			limit: 1,
			cursor: mcpPage.nextCursor,
		});
	const mcpDraft = z
		.object({ draftId: z.string(), revision: z.number() })
		.parse(
			await mcpTool("draft_reply", {
				mailboxId: "mailbox",
				emailId: "message",
				body: "An assistant reply saved for review.",
			}),
		);
	const mcpDraftRead = z
		.object({ revision: z.number(), text: z.string() })
		.parse(
			await mcpTool("get_email", {
				mailboxId: "mailbox",
				emailId: mcpDraft.draftId,
			}),
		);
	if (
		mcpDraftRead.revision !== mcpDraft.revision ||
		mcpDraftRead.text !== "An assistant reply saved for review."
	)
		throw new Error("Compiled MCP body/revision snapshot failed");
	const mcpApproval = z
		.object({ approvalId: z.string(), reviewUrl: z.string() })
		.parse(
			await mcpTool("request_send", {
				mailboxId: "mailbox",
				draftId: mcpDraft.draftId,
				expectedRevision: mcpDraft.revision,
			}),
		);
	if (!mcpApproval.reviewUrl.startsWith(`${publicBase}/agent/review/`))
		throw new Error("Compiled MCP review URL failed");
	const mcpApprovalRead = await fetch(
		`${base}/api/agent/approvals/${mcpApproval.approvalId}`,
		{ headers: { Cookie: sessionCookie } },
	);
	if (
		!mcpApprovalRead.ok ||
		!z
			.object({ status: z.literal("pending"), stale: z.literal(false) })
			.safeParse(await mcpApprovalRead.json()).success
	)
		throw new Error("Compiled human review read failed");
	if (
		(
			await fetch(
				`${base}/api/agent/approvals/${mcpApproval.approvalId}/confirm`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${mcpKey.key}`,
						Origin: publicBase,
					},
				},
			)
		).status !== 401
	)
		throw new Error("An MCP key authenticated human confirmation");
	const reviewPage = await fetch(
		`${base}/agent/review/${mcpApproval.approvalId}`,
		{ headers: { Cookie: sessionCookie } },
	);
	if (!reviewPage.ok || !(await reviewPage.text()).includes("AI draft review"))
		throw new Error("Original review page failed");
	const reviewUserToken = crypto.randomUUID();
	state.db
		.query(
			"INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES('review-user','stranger',?,?,?)",
		)
		.run(await hash(reviewUserToken), seconds() + 300, seconds());
	const otherReview = await fetch(
		`${base}/agent/review/${mcpApproval.approvalId}`,
		{
			headers: { Cookie: `ep_session=${reviewUserToken}` },
			redirect: "manual",
		},
	);
	if (
		otherReview.status !== 200 ||
		!(await otherReview.text()).includes("AI draft review")
	)
		throw new Error("Non-admin review was redirected into administration");
	if (
		(
			await fetch(`${base}/api/agent/approvals/${mcpApproval.approvalId}`, {
				headers: { Cookie: `ep_session=${reviewUserToken}` },
			})
		).status !== 404
	)
		throw new Error("Another user could read a private approval");
	await mcpTool("discard_draft", {
		mailboxId: "mailbox",
		draftId: mcpDraft.draftId,
		expectedRevision: mcpDraft.revision,
	});
	const publicAdminKeyResponse = await fetch(`${base}/api/admin/api-keys`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			name: "Public administration",
			scopes: ["accounts", "mailboxes", "domains", "storage"],
		}),
	});
	const publicAdminSecret = z
		.object({ key: z.string() })
		.parse(await publicAdminKeyResponse.json());
	const publicAdminKeys = await fetch(`${base}/api/admin/api-keys`, {
		headers: { Cookie: sessionCookie },
	});
	const publicAdminId = z
		.object({
			apiKeys: z.array(z.object({ id: z.string(), prefix: z.string() })),
		})
		.parse(await publicAdminKeys.json())
		.apiKeys.find(
			(row) => row.prefix === publicAdminSecret.key.slice(0, 12),
		)?.id;
	if (!publicAdminId)
		throw new Error("Created administrative key was not listed");
	const publicAdminKey = { ...publicAdminSecret, id: publicAdminId };
	if (!publicAdminKeyResponse.ok)
		throw new Error("Public administrative key creation failed");
	const publicRead = await fetch(
		`${base}/api/v1/messages?q=subject:searchable`,
		{ headers: { Authorization: `Bearer ${publicMailKey.key}` } },
	);
	if (
		!publicRead.ok ||
		!z
			.object({
				messages: z.array(
					z.object({ id: z.string(), textBody: z.string().nullable() }),
				),
			})
			.parse(await publicRead.json())
			.messages.some(
				(row) => row.id === "message" && row.textBody === "Welcome to Mailrun",
			)
	)
		throw new Error("Public source message contract failed");
	if (
		(
			await fetch(`${base}/api/v1/messages`, {
				headers: { Cookie: sessionCookie },
			})
		).status !== 401 ||
		(
			await fetch(`${base}/api/v1/accounts`, {
				headers: { Authorization: `Bearer ${publicMailKey.key}` },
			})
		).status !== 401
	)
		throw new Error("Public scope/session isolation failed");
	const publicStorage = await fetch(`${base}/api/v1/storage`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${publicAdminKey.key}`,
			Origin: "https://external-client.example",
		},
	});
	if (
		!publicStorage.ok ||
		!z
			.object({
				ok: z.literal(true),
				storage: z.object({ provider: z.literal("files") }),
			})
			.safeParse(await publicStorage.json()).success
	)
		throw new Error("Public local storage health failed");
	const publicAccounts = await fetch(`${base}/api/v1/accounts`, {
		headers: { Authorization: `Bearer ${publicAdminKey.key}` },
	});
	const publicAccountIds = z
		.object({ accounts: z.array(z.object({ id: z.string() })) })
		.parse(await publicAccounts.json())
		.accounts.map((row) => row.id);
	if (
		!publicAccounts.ok ||
		!publicAccountIds.includes(managed.id) ||
		publicAccountIds.includes("stranger")
	)
		throw new Error("Public creator scope failed");
	const publicMailbox = await fetch(`${base}/api/v1/mailboxes`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${publicAdminKey.key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			domainId: "domain",
			ownerUserId: managed.id,
			localPart: "public-extra",
		}),
	});
	const publicBox = z
		.object({ id: z.string() })
		.parse(await publicMailbox.json());
	if (publicMailbox.status !== 201)
		throw new Error("Public mailbox creation failed");
	const publicMailboxUpdate = await fetch(
		`${base}/api/v1/mailboxes/${publicBox.id}`,
		{
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${publicAdminKey.key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ signature: "Public signature" }),
		},
	);
	if (
		!publicMailboxUpdate.ok ||
		(
			await fetch(`${base}/api/v1/mailboxes/${publicBox.id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${publicAdminKey.key}` },
			})
		).status !== 200
	)
		throw new Error("Public mailbox mutation failed");
	const apiLargeContent = Buffer.alloc(8_000_000).toString("base64");
	let apiMemoryPeak = 0,
		apiMemoryRunning = true;
	const apiMemorySampler = (async () => {
		while (apiMemoryRunning) {
			const probe = Bun.spawn(["ps", "-o", "rss=", "-p", String(child.pid)], {
				stdout: "pipe",
			});
			const value = Number((await new Response(probe.stdout).text()).trim());
			await probe.exited;
			apiMemoryPeak = Math.max(apiMemoryPeak, value / 1024);
			await Bun.sleep(10);
		}
	})();
	let publicScheduled: Response;
	try {
		publicScheduled = await fetch(`${base}/api/v1/send`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${publicMailKey.key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				mailboxId: "mailbox",
				from: "hello@example.com",
				to: "recipient@example.org",
				subject: "Public scheduled HTTP",
				text: "Synthetic queued API body",
				scheduledAt: "2099-01-01T00:00:00Z",
				attachments: [0, 1, 2].map((index) => ({
					filename: `api-bulk-${index}.bin`,
					contentBase64: apiLargeContent,
				})),
			}),
		});
	} finally {
		apiMemoryRunning = false;
		await apiMemorySampler;
	}
	if (
		!publicScheduled.ok ||
		!z
			.object({ messageId: z.string(), scheduled: z.literal(true) })
			.safeParse(await publicScheduled.json()).success
	)
		throw new Error("Public scheduled send failed");
	const publicDomainList = await fetch(`${base}/api/v1/domains`, {
		headers: { Authorization: `Bearer ${publicAdminKey.key}` },
	});
	if (
		!publicDomainList.ok ||
		!z
			.object({
				domains: z.array(z.object({ id: z.string() })),
				dns: z.record(z.string(), z.unknown()),
			})
			.parse(await publicDomainList.json())
			.domains.some((row) => row.id === "domain")
	)
		throw new Error("Public domain contract failed");
	await fetch(`${base}/api/api-keys?id=${publicMailKey.id}`, {
		method: "DELETE",
		headers: calendarHeaders,
	});
	await fetch(`${base}/api/admin/api-keys?id=${publicAdminKey.id}`, {
		method: "DELETE",
		headers: calendarHeaders,
	});
	if (
		(
			await fetch(`${base}/api/v1/messages`, {
				headers: { Authorization: `Bearer ${publicMailKey.key}` },
			})
		).status !== 401
	)
		throw new Error("Public key revocation failed");
	const createdKeyResponse = await fetch(`${base}/api/api-keys`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			name: "Smoke calendar key",
			scopes: ["calendar:read"],
			mailboxIds: [],
		}),
	});
	const createdKey = z
		.object({ id: z.string(), key: z.string() })
		.parse(await createdKeyResponse.json());
	if (
		!createdKeyResponse.ok ||
		!(
			await fetch(`${base}/api/calendar/events`, {
				headers: { Authorization: `Bearer ${createdKey.key}` },
			})
		).ok
	)
		throw new Error("Managed calendar key failed");
	const listedKeys = await fetch(`${base}/api/api-keys`, {
		headers: { Cookie: sessionCookie },
	});
	const listedKeyText = await listedKeys.text();
	if (!listedKeys.ok || listedKeyText.includes(createdKey.key))
		throw new Error("Key list exposed secret");
	const revokedKey = await fetch(`${base}/api/api-keys?id=${createdKey.id}`, {
		method: "DELETE",
		headers: calendarHeaders,
	});
	if (
		!revokedKey.ok ||
		(
			await fetch(`${base}/api/calendar/events`, {
				headers: { Authorization: `Bearer ${createdKey.key}` },
			})
		).status !== 401
	)
		throw new Error("API key revocation failed");
	const general = await fetch(`${base}/api/admin/general`, {
		method: "PUT",
		headers: calendarHeaders,
		body: JSON.stringify({
			outboundAttachmentMaxMb: 2,
			driveStorageLimitGb: 1,
		}),
	});
	const generalData = await general.json();
	if (
		!general.ok ||
		!z
			.object({
				outboundAttachmentMaxMb: z.literal(2),
				driveStorageLimitGb: z.literal(1),
			})
			.safeParse(generalData).success
	)
		throw new Error(
			`General settings failed: ${general.status} ${JSON.stringify(generalData)}`,
		);
	await fetch(`${base}/api/admin/general`, {
		method: "PUT",
		headers: calendarHeaders,
		body: JSON.stringify({
			outboundAttachmentMaxMb: 25,
			driveStorageLimitGb: null,
		}),
	});
	const activities = await fetch(`${base}/api/activity`, {
		headers: { Cookie: sessionCookie },
	});
	if (
		!activities.ok ||
		!z
			.object({ activities: z.array(z.object({ action: z.string() })) })
			.parse(await activities.json())
			.activities.some((row) => row.action === "auth.login")
	)
		throw new Error("Authentication activity was not recorded");
	const resetHeaders = {
			Origin: publicBase,
			"Content-Type": "application/json",
		},
		unknownReset = await fetch(`${base}/api/auth/password-reset/request`, {
			method: "POST",
			headers: resetHeaders,
			body: JSON.stringify({ email: "unknown@example.net" }),
		});
	if (!unknownReset.ok) throw new Error("Public reset request failed");
	const resetToken = crypto.randomUUID(),
		resetPassword = crypto.randomUUID();
	state.db
		.query(
			"INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES('reset-smoke',?,?,?,?)",
		)
		.run(managed.id, await hash(resetToken), seconds() + 1800, seconds());
	const confirmReset = () =>
		fetch(`${base}/api/auth/password-reset/confirm`, {
			method: "POST",
			headers: resetHeaders,
			body: JSON.stringify({ token: resetToken, password: resetPassword }),
		});
	if (!(await confirmReset()).ok || (await confirmReset()).status !== 400)
		throw new Error("Reset link was not single-use");
	const recoveredLogin = await fetch(`${base}/api/auth/login`, {
		method: "POST",
		headers: resetHeaders,
		body: JSON.stringify({ email: managed.email, password: resetPassword }),
	});
	if (!recoveredLogin.ok) throw new Error("Reset password could not sign in");
	for (const route of [
		"/general",
		"/activity",
		"/api-keys",
		"/settings/api-keys",
		"/settings/app-passwords",
		"/settings/import",
		"/settings/export",
		"/backups",
		"/branding",
		"/licenses",
		"/routing",
		"/webhooks",
	])
		if (!(await fetch(base + route, { headers: { Cookie: sessionCookie } })).ok)
			throw new Error(`Restored settings route failed: ${route}`);
	for (const route of [
		"/forgot-password",
		"/reset-password?token=synthetic-token",
	])
		if (!(await fetch(base + route)).ok)
			throw new Error(`Public recovery page failed: ${route}`);
	const memorySamples: Record<string, number> = {};
	const sampleMemory = async (label: string) => {
		const probe = Bun.spawn(["ps", "-o", "rss=", "-p", String(child.pid)], {
			stdout: "pipe",
		});
		memorySamples[label] = Math.round(
			Number((await new Response(probe.stdout).text()).trim()) / 1024,
		);
	};
	await sampleMemory("beforeDrive");
	const driveFolderResponse = await fetch(`${base}/api/drive/items`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({ name: "Standalone Drive" }),
	});
	const folderId = z
		.object({ item: z.object({ id: z.string() }) })
		.parse(await driveFolderResponse.json()).item.id;
	const largePart = 64 * 1024 * 1024,
		largePath = resolve(state.directory, "drive-stream-part");
	await Bun.write(largePath, "");
	await truncate(largePath, largePart);
	const partHandle = await open(largePath, "r+");
	await partHandle.write(new TextEncoder().encode("last"), 0, 4, largePart - 4);
	await partHandle.close();
	const uploadInfo = {
		name: "Streamed.pdf",
		size: largePart * 3 + 4,
		parentId: folderId,
		contentType: "application/pdf",
		fingerprint: "smoke-streamed",
	};
	const uploadStart = await fetch(`${base}/api/drive/upload`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify(uploadInfo),
	});
	const upload = z
		.object({
			id: z.string(),
			partSize: z.literal(64 * 1024 * 1024),
			uploaded: z.array(z.number()),
		})
		.parse(await uploadStart.json());
	const firstPart = await fetch(
		`${base}/api/drive/upload/${upload.id}?part=1`,
		{
			method: "PUT",
			headers: {
				Cookie: sessionCookie,
				Origin: publicBase,
				"Content-Length": String(largePart),
			},
			body: Bun.file(largePath),
		},
	);
	if (!firstPart.ok)
		throw new Error(
			`64 MiB streamed upload failed: ${firstPart.status} ${await firstPart.text()}`,
		);
	await sampleMemory("afterPart");
	const resumedResponse = await fetch(`${base}/api/drive/upload`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify(uploadInfo),
	});
	const resumed = z
		.object({
			id: z.literal(upload.id),
			uploaded: z.array(z.number()),
			resumed: z.literal(true),
		})
		.parse(await resumedResponse.json());
	if (!resumed.uploaded.includes(1))
		throw new Error("Drive part resume failed");
	for (const part of [2, 3]) {
		const response = await fetch(
			`${base}/api/drive/upload/${upload.id}?part=${part}`,
			{
				method: "PUT",
				headers: {
					Cookie: sessionCookie,
					Origin: publicBase,
					"Content-Length": String(largePart),
				},
				body: Bun.file(largePath),
			},
		);
		if (!response.ok)
			throw new Error(
				`Sustained Drive upload failed at part ${part}: ${response.status}`,
			);
	}
	await sampleMemory("afterThreeParts");
	const secondPart = await fetch(
		`${base}/api/drive/upload/${upload.id}?part=4`,
		{
			method: "PUT",
			headers: {
				Cookie: sessionCookie,
				Origin: publicBase,
				"Content-Length": "4",
			},
			body: "tail",
		},
	);
	const completedUpload = await fetch(`${base}/api/drive/upload/${upload.id}`, {
		method: "POST",
		headers: calendarHeaders,
	});
	if (!secondPart.ok || !completedUpload.ok)
		throw new Error(`Drive completion failed ${await completedUpload.text()}`);
	await sampleMemory("afterAssembly");
	const driveRange = await fetch(
		`${base}/api/drive/items/${upload.id}/content`,
		{
			headers: { Cookie: sessionCookie, Range: `bytes=${largePart * 3 - 4}-` },
		},
	);
	if (driveRange.status !== 206 || (await driveRange.text()) !== "lasttail")
		throw new Error("Drive Range preview failed");
	const driveHead = await fetch(
		`${base}/api/drive/items/${upload.id}/content`,
		{ method: "HEAD", headers: { Cookie: sessionCookie } },
	);
	if (
		driveHead.status !== 200 ||
		driveHead.headers.get("Content-Length") !== String(largePart * 3 + 4)
	)
		throw new Error("Drive HEAD failed");
	const linkResponse = await fetch(`${base}/api/drive/items/${folderId}/link`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({ enabled: true }),
	});
	const link = z
		.object({ linkToken: z.string() })
		.parse(await linkResponse.json()).linkToken;
	const publicFile = await fetch(
		`${base}/api/drive/public/${link}?item=${upload.id}&content=1`,
		{ headers: { Range: "bytes=-4" } },
	);
	if (publicFile.status !== 206 || (await publicFile.text()) !== "tail")
		throw new Error("Public Drive stream failed");
	const publicDrivePage = await fetch(`${base}/d/${link}`);
	if (!publicDrivePage.ok) throw new Error("Public Drive page failed");
	const privateDrive = await fetch(
		`${base}/api/drive/items/${upload.id}/content`,
	);
	if (privateDrive.status !== 401)
		throw new Error("Drive leaked private content");
	const drivePage = await fetch(`${base}/drive`, {
		headers: { Cookie: sessionCookie },
	});
	if (!drivePage.ok) throw new Error("Original Drive screen failed");
	await fetch(`${base}/api/drive/items/${folderId}/link`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({ enabled: false }),
	});
	if ((await fetch(`${base}/api/drive/public/${link}`)).status !== 404)
		throw new Error("Revoked public Drive link remained accessible");
	await sampleMemory("afterDriveScreens");
	const savedEvent = await fetch(`${base}/api/calendar/events`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify({
			title: "Standalone calendar",
			startsAt: "2030-01-07T09:00:00Z",
			endsAt: "2030-01-07T10:00:00Z",
			repeat: "daily",
			timeZone: "UTC",
		}),
	});
	const calendarEvent = z
		.object({ event: z.object({ id: z.string(), repeat: z.literal("daily") }) })
		.parse(await savedEvent.json()).event;
	if (!savedEvent.ok) throw new Error("Calendar event creation failed");
	const calendarList = await fetch(
		`${base}/api/calendar/events?start=2030-01-01T00:00:00Z&end=2030-02-01T00:00:00Z`,
		{ headers: { Cookie: sessionCookie } },
	);
	if (
		!calendarList.ok ||
		!z
			.object({ events: z.array(z.object({ id: z.string() })) })
			.parse(await calendarList.json())
			.events.some((event) => event.id === calendarEvent.id)
	)
		throw new Error("Calendar event retrieval failed");
	const calendarKey = "ep_standalone-calendar-key";
	state.db
		.query(
			"INSERT INTO api_keys (id,user_id,name,key_hash,prefix,scopes,created_at) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			"calendar-key",
			"owner",
			"Calendar smoke",
			await bcrypt.hash(calendarKey, 4),
			calendarKey.slice(0, 12),
			'["calendar:read"]',
			1,
		);
	const basicCalendar = await fetch(`${base}/api/calendar/events`, {
		headers: { Authorization: "Basic " + btoa("ignored:" + calendarKey) },
	});
	if (!basicCalendar.ok)
		throw new Error("Calendar API key authentication failed");
	const deniedCalendar = await fetch(`${base}/api/calendar/events`, {
		method: "POST",
		headers: {
			Authorization: "Bearer " + calendarKey,
			"Content-Type": "application/json",
		},
		body: "{}",
	});
	if (deniedCalendar.status !== 403)
		throw new Error("Calendar read key could mutate events");
	const bookingInput = {
		name: "Standalone booking",
		slug: "standalone",
		description: "Synthetic compiled test",
		hostIds: ["owner"],
		durationMinutes: 30,
		location: "Test room",
		weekdays: [0, 1, 2, 3, 4, 5, 6],
		timeRanges: [{ startTime: "09:00", endTime: "17:00" }],
		timeZone: "UTC",
		enabled: true,
	};
	const createdBooking = await fetch(`${base}/api/booking`, {
		method: "POST",
		headers: calendarHeaders,
		body: JSON.stringify(bookingInput),
	});
	const bookingId = z
		.object({ event: z.object({ id: z.string() }) })
		.parse(await createdBooking.json()).event.id;
	if (!createdBooking.ok) throw new Error("Booking creation failed");
	const publicEvent = await fetch(`${base}/api/public/booking/${bookingId}`);
	const publicSlots = z
		.object({ slots: z.array(z.object({ startsAt: z.string() })) })
		.parse(await publicEvent.json());
	const slot = publicSlots.slots[0];
	if (!publicEvent.ok || !slot)
		throw new Error("Public booking availability failed");
	const reservationInput = {
		name: "Synthetic guest",
		email: "guest@example.net",
		startsAt: slot.startsAt,
		notes: "Standalone smoke",
	};
	const reserve = () =>
		fetch(`${base}/api/public/booking/${bookingId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(reservationInput),
		});
	const reserved = await reserve();
	if (!reserved.ok)
		throw new Error(`Public reservation failed: ${reserved.status}`);
	const duplicate = await reserve();
	if (duplicate.status !== 409)
		throw new Error("Duplicate reservation did not conflict");
	const publicPage = await fetch(`${base}/book/owner/${bookingId}`);
	if (!publicPage.ok || !(await publicPage.text()).includes("Mailflare"))
		throw new Error("Public booking route failed");
	const draftInput = {
		mailboxId: "mailbox",
		to: "maya@example.net",
		subject: "Smoke draft",
		html: "<p>Draft</p>",
		text: "Draft",
	};
	const saved = await fetch(`${base}/api/drafts`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(draftInput),
	});
	const savedDraft = z
		.object({ draft: z.object({ id: z.string() }) })
		.parse(await saved.json()).draft;
	if (
		!saved.ok ||
		!saved.headers.get("etag") ||
		saved.headers.get("X-Mailflare-Draft-Revision") !== "0" ||
		!saved.headers.get("Cache-Control")?.includes("no-transform")
	)
		throw new Error("Draft creation or revision headers failed");
	const updated = await fetch(`${base}/api/drafts/${savedDraft.id}`, {
		method: "PATCH",
		headers: {
			Cookie: sessionCookie,
			Origin: publicBase,
			"Content-Type": "application/json",
			"If-Match": saved.headers.get("etag") ?? "",
		},
		body: JSON.stringify({ ...draftInput, subject: "Updated smoke draft" }),
	});
	if (!updated.ok) throw new Error(`Draft update failed: ${updated.status}`);
	const stale = await fetch(`${base}/api/drafts/${savedDraft.id}`, {
		method: "PATCH",
		headers: {
			Cookie: sessionCookie,
			Origin: publicBase,
			"Content-Type": "application/json",
			"If-Match": saved.headers.get("etag") ?? "",
		},
		body: JSON.stringify(draftInput),
	});
	if (stale.status !== 409)
		throw new Error(`Stale draft returned ${stale.status}`);
	const files = new FormData();
	files.append(
		"attachments",
		new File(["%PDF-1.4\n%%EOF"], "smoke.pdf", { type: "application/pdf" }),
	);
	const uploaded = await fetch(
		`${base}/api/drafts/${savedDraft.id}/attachments`,
		{
			method: "POST",
			headers: {
				Cookie: sessionCookie,
				Origin: publicBase,
				"If-Match": updated.headers.get("etag") ?? "",
			},
			body: files,
		},
	);
	const attachment = z
		.object({ attachments: z.array(z.object({ id: z.string() })) })
		.parse(await uploaded.json()).attachments[0];
	if (!uploaded.ok || !attachment) throw new Error("Draft attachment failed");
	const preview = await fetch(
		`${base}/api/messages/${savedDraft.id}/attachments/${attachment.id}?preview=1`,
		{ headers: { Cookie: sessionCookie } },
	);
	if (
		!preview.ok ||
		!preview.headers.get("content-disposition")?.startsWith("inline") ||
		preview.headers.get("x-frame-options") !== "SAMEORIGIN"
	)
		throw new Error("Protected attachment preview failed");
	const foreignPreview = await fetch(
		`${base}/api/messages/${savedDraft.id}/attachments/${attachment.id}?preview=1`,
		{ headers: { Cookie: `ep_session=invalid` } },
	);
	if (foreignPreview.status !== 401)
		throw new Error("Attachment authorization failed");
	// Exercise the compiled Bun websocket and the Start handler in the same process.
	state.db.exec(
		"INSERT INTO mailrun_installation VALUES ('primary','account','zone','example.com','relay','https://mailrun-smoke.example','synthetic-token','synthetic-secret','v1','ready',1)",
	);
	// DOM globals hide Bun's documented headers overload in this shared TS project.
	const NativeWebSocket = WebSocket as typeof WebSocket & {
		new (url: string, options: Bun.WebSocketOptions): WebSocket;
	};
	const socket = new NativeWebSocket(
		base.replace("http:", "ws:") + "/api/realtime",
		{ headers: { Cookie: sessionCookie, Origin: publicBase } },
	);
	const frames: string[] = [];
	socket.addEventListener("message", (event) =>
		frames.push(String(event.data)),
	);
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("WebSocket did not connect")),
			5000,
		);
		socket.addEventListener(
			"open",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			() => {
				clearTimeout(timeout);
				reject(new Error("WebSocket connection failed"));
			},
			{ once: true },
		);
	});
	const nextFrame = (type: string) =>
		new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				socket.removeEventListener("message", receive);
				reject(new Error("Missing websocket " + type));
			}, 5000);
			const receive = (event: MessageEvent) => {
				const data: unknown = JSON.parse(String(event.data));
				const parsed = z.object({ type: z.string() }).passthrough().parse(data);
				if (parsed.type === type) {
					clearTimeout(timeout);
					socket.removeEventListener("message", receive);
					resolve(parsed);
				}
			};
			socket.addEventListener("message", receive);
		});
	const revision = nextFrame("revision");
	socket.send(JSON.stringify({ type: "ping", revision: null }));
	await revision;
	const newMail = nextFrame("new_message");
	const raw = new TextEncoder().encode(
		"From: sender@example.org\r\nTo: hello@example.com\r\nSubject: Live notification\r\nMessage-ID: <smoke-live@example.org>\r\n\r\nSynthetic realtime test",
	);
	const timestamp = String(Date.now());
	const delivered = await fetch(`${base}/api/inbound`, {
		method: "POST",
		headers: {
			"x-mailrun-from": "sender@example.org",
			"x-mailrun-to": "hello@example.com",
			"x-mailrun-timestamp": timestamp,
			"x-mailrun-signature": await signRelay(
				"synthetic-secret",
				timestamp,
				"sender@example.org",
				"hello@example.com",
				raw,
			),
			"x-mailrun-relay": "2",
		},
		body: raw,
	});
	if (!delivered.ok) throw new Error("Signed relay delivery failed");
	await newMail;
	let eagerDelivery = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		const history = await fetch(`${base}/api/webhooks/${hook.id}/deliveries`, {
			headers: { Cookie: sessionCookie },
		});
		const rows = z
			.object({
				deliveries: z.array(
					z.object({ status: z.string(), payload: z.string() }),
				),
			})
			.parse(await history.json()).deliveries;
		eagerDelivery = rows.some(
			(row) =>
				row.status === "delivered" &&
				row.payload.includes('"subject":"Live notification"'),
		);
		if (eagerDelivery) break;
		await Bun.sleep(10);
	}
	const receivedHook = webhookRequests.find((row) =>
		row.body.includes('"subject":"Live notification"'),
	);
	if (
		!eagerDelivery ||
		!receivedHook ||
		receivedHook.headers.get("x-email-platform-signature") !==
			createHmac("sha256", rotatedSecret)
				.update(receivedHook.body)
				.digest("hex")
	)
		throw new Error("Eager signed inbound webhook did not arrive");
	socket.close();

	const health = await fetch(`${base}/api/health`);
	if (!health.ok)
		throw new Error(`Health failed: ${health.status} ${await health.text()}`);
	const anonymous = await fetch(`${base}/inbox`, { redirect: "manual" });
	if (anonymous.status !== 307 && anonymous.status !== 302)
		throw new Error(`Anonymous inbox was not redirected: ${anonymous.status}`);
	const authenticated = await fetch(`${base}/inbox`, {
		headers: { Cookie: `ep_session=${token}` },
	});
	const html = await authenticated.text();
	if (!authenticated.ok || !html.includes("Mailflare"))
		throw new Error(
			`Inbox SSR failed: ${authenticated.status} ${html.slice(0, 1000)}`,
		);
	if (authenticated.headers.get("cache-control") !== "private, no-store")
		throw new Error("Private inbox is cacheable");
	const asset = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/)?.[1];
	if (!asset) throw new Error("No client asset in rendered page");
	const response = await fetch(base + asset);
	if (!response.ok) throw new Error("Embedded asset missing");
	if (!response.headers.get("content-type")?.includes("javascript"))
		throw new Error("Embedded JavaScript has the wrong content type");
	const etag = response.headers.get("etag");
	const conditional = await fetch(base + asset, {
		headers: { "If-None-Match": etag ?? "" },
	});
	if (conditional.status !== 304)
		throw new Error("Conditional asset request did not return 304");
	const deniedDownload = await fetch(`${base}/api/messages/message/original`);
	if (deniedDownload.status !== 401)
		throw new Error(
			`Unauthenticated download returned ${deniedDownload.status}`,
		);
	const backupResponse = await fetch(`${base}/api/backups`, {
		method: "POST",
		headers: calendarHeaders,
	});
	const backup = z
		.object({ backupId: z.string() })
		.parse(await backupResponse.json());
	if (!backupResponse.ok) throw new Error("Manual local backup failed");
	const backupDownload = await fetch(
		`${base}/api/backups/${backup.backupId}/download`,
		{ headers: { Cookie: sessionCookie } },
	);
	const backupFile = await backupDownload.blob();
	if (!backupDownload.ok || backupFile.size === 0)
		throw new Error("Local backup download failed");
	const invalidForm = new FormData();
	invalidForm.set("backup", new File(['{"format":"wrong"}'], "invalid.json"));
	const invalidRestore = await fetch(`${base}/api/backups/restore`, {
		method: "POST",
		headers: { Cookie: sessionCookie, Origin: publicBase },
		body: invalidForm,
	});
	if (invalidRestore.status !== 400)
		throw new Error("Invalid restore was not rejected");
	const restoreForm = new FormData();
	restoreForm.set(
		"backup",
		new File([backupFile], "backup.json", { type: "application/json" }),
	);
	const backupRestore = await fetch(`${base}/api/backups/restore`, {
		method: "POST",
		headers: { Cookie: sessionCookie, Origin: publicBase },
		body: restoreForm,
	});
	if (
		!backupRestore.ok ||
		!(
			await fetch(`${base}/api/messages?mailboxId=mailbox`, {
				headers: { Cookie: sessionCookie },
			})
		).ok
	)
		throw new Error("Local backup restore failed");
	const backupDelete = await fetch(`${base}/api/backups/${backup.backupId}`, {
		method: "DELETE",
		headers: calendarHeaders,
	});
	if (
		!backupDelete.ok ||
		(
			await fetch(`${base}/api/backups/${backup.backupId}/download`, {
				headers: { Cookie: sessionCookie },
			})
		).status !== 404
	)
		throw new Error("Local backup deletion failed");
	const auditAlias = await fetch(`${base}/audit-logs`, {
		headers: { Cookie: sessionCookie },
		redirect: "manual",
	});
	if (
		![302, 307].includes(auditAlias.status) ||
		!auditAlias.headers.get("location")?.includes("/activity")
	)
		throw new Error("Audit URL alias failed");
	webhookStatus = 503;
	const cronHookResponse = await fetch(`${base}/api/webhooks/${hook.id}/test`, {
		method: "POST",
		headers: calendarHeaders,
	});
	const cronHook = z
		.object({ deliveryId: z.string(), status: z.literal("retrying") })
		.parse(await cronHookResponse.json());
	if (!cronHookResponse.ok)
		throw new Error("Failed webhook could not be queued for cron recovery");
	state.db
		.query("UPDATE webhook_deliveries SET next_retry_at=0 WHERE id=?")
		.run(cronHook.deliveryId);
	webhookStatus = 204;
	const task = Bun.spawn([binary, "jobs", "maintenance"], {
		cwd: state.directory,
		env: smokeEnvironment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const taskExit = await task.exited;
	const taskOutput = await new Response(task.stdout).text();
	if (taskExit !== 0 || !taskOutput.includes('"job":"maintenance"'))
		throw new Error(
			`Compiled cron task failed: ${taskOutput} ${await new Response(task.stderr).text()}`,
		);
	const cronWebhookState = state.db
		.query<{ status: string; attempts: number }, [string]>(
			"SELECT status,attempts FROM webhook_deliveries WHERE id=?",
		)
		.get(cronHook.deliveryId);
	if (
		cronWebhookState?.status !== "delivered" ||
		cronWebhookState.attempts !== 2
	)
		throw new Error(
			"Persisted webhook retry did not run through the compiled cron command",
		);
	const registeredTask = Bun.spawn(
		[
			binary,
			"run",
			"--cron-title=mailrun-maintenance",
			"--cron-period=* * * * *",
		],
		{
			cwd: state.directory,
			env: smokeEnvironment,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (
		(await registeredTask.exited) !== 0 ||
		!(await new Response(registeredTask.stdout).text()).includes(
			'"job":"maintenance"',
		)
	)
		throw new Error("Bun cron argument dispatch failed");
	const rssProcess = Bun.spawn(["ps", "-o", "rss=", "-p", String(child.pid)], {
		stdout: "pipe",
	});
	const rssKiB = Number((await new Response(rssProcess.stdout).text()).trim());
	console.log(
		JSON.stringify(
			{
				binary,
				health: "passed",
				csrfProtection: "passed",
				originalRestLogin: "passed",
				originalMessageApi: "passed",
				calendarEvents: "passed",
				managedAccountCreation: "passed",
				adminPasswordResetRevocation: "passed",
				originalAccountScreens: "passed",
				originalDomainScreenAndList: "passed",
				managedKeyLifecycle: "passed",
				generalSettingsAndActivity: "passed",
				passwordResetSingleUse: "passed",
				restoredSecurityAndAdminPages: "passed",
				localBackupRestoreAndDeletion: "passed",
				signedWebhooksAndCronRetries: "passed",
				emlImportAndMboxExport: "passed",
				publicApiScopesAndAdministration: "passed",
				jmapProtocol: "passed",
				mcpProtocolAndHumanReview: "passed",
				publicScheduledSend: "passed",
				apiSendPeakMiB: Math.round(apiMemoryPeak),
				nativeTransferAuthenticationAndAliases: "passed",
				drive192MiBStreaming: "passed",
				nativeUploadAuthAndCsrf: "passed",
				driveResume: "passed",
				driveRangeAndHead: "passed",
				driveSharingAndRevocation: "passed",
				originalDriveScreen: "passed",
				calendarApiKeys: "passed",
				publicBooking: "passed",
				bookingConflict: "passed",
				conditionalDraftWrites: "passed",
				attachmentPreviews: "passed",
				liveEmailNotifications: "passed",
				unauthenticatedRedirect: "passed",
				authenticatedInboxSsr: "passed",
				embeddedAssets: "passed",
				conditionalAssets: "passed",
				standaloneCwd: "passed",
				taskCommand: "passed",
				bunCronDispatch: "passed",
				downloadAuthorization: "passed",
				rssMiB: Math.round(rssKiB / 1024),
				driveMemoryMiB: memorySamples,
			},
			null,
			2,
		),
	);
} finally {
	child.kill();
	await child.exited;
	const error = await new Response(child.stderr).text();
	if (error.trim()) console.error(error);
	await webhookReceiver.stop(true);
	await state.close();
}
