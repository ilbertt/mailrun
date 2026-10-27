import { open, truncate } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "../tests/fixtures";
import { seconds } from "../src/server/db";
import { hash } from "../src/server/auth/service";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signRelay } from "../src/shared/relay-signature";

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
const publicBase = "https://mailrun-smoke.example";
const smokeEnvironment: Record<string, string | undefined> = {
	PATH: process.env.PATH,
	HOME: process.env.HOME,
	TMPDIR: process.env.TMPDIR,
	DATA_DIR: state.directory,
	PORT: "0",
	HOST: "127.0.0.1",
	APP_URL: publicBase,
	NODE_ENV: "production",
};
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

	state.db.exec(
		"INSERT INTO license_settings(id,instance_id,plan,state,updated_at) VALUES('default','http-smoke','team','active',1) ON CONFLICT(id) DO UPDATE SET plan='team',state='active'",
	);
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
	if (!saved.ok || !saved.headers.get("etag"))
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
	await state.close();
}
