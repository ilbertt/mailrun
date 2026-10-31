import { test, expect, beforeEach, afterEach } from "bun:test";
import { fixture, owner, stranger, enableTeamSharing } from "./fixtures";
import {
	navigationCounts,
	moveMessages,
	shortcutSettings,
} from "../src/server/mail/navigation";
import { createFolder } from "../src/server/mail/management";
import { saveDraft } from "../src/server/mail/drafts";
import { listMessages } from "../src/server/mail/repository";
import {
	resolveLayout,
	moveItem,
} from "../src/components/reorderable-list-utils";
let state: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	state = await fixture();
});
afterEach(async () => {
	await state.close();
});
test("navigation counts keep snoozed/custom folders distinct and drafts private", async () => {
	const folder = await createFolder(owner, {
		mailboxId: "mailbox",
		name: "Work",
		color: "#16a34a",
	});
	await moveMessages(owner, {
		messageIds: ["message"],
		action: "folder",
		folderId: folder.id,
	});
	const own = await saveDraft(owner, {
		mailboxId: "mailbox",
		to: "",
		cc: "",
		bcc: "",
		subject: "Private",
		html: "",
		text: "",
	});
	enableTeamSharing(state.db);
	state.db.exec(
		"INSERT INTO mailbox_access (id,mailbox_id,user_id,permission,created_at) VALUES ('share','mailbox','stranger','read_only',1)",
	);
	const counts = await navigationCounts(owner, "mailbox");
	expect(counts.folders.inbox.total).toBe(0);
	expect(counts.customFolders[folder.id]).toEqual({ total: 1, unread: 1 });
	expect(counts.folders.drafts.total).toBe(1);
	expect(
		(await navigationCounts(stranger, "mailbox")).folders.drafts.total,
	).toBe(0);
	expect(
		(
			await listMessages(owner, {
				mailboxId: "mailbox",
				folder: "inbox",
				folderId: folder.id,
				q: "",
				offset: 0,
			})
		).messages[0]?.id,
	).toBe("message");
	state.db
		.query("UPDATE messages SET snoozed_until=? WHERE id='message'")
		.run(Math.floor(Date.now() / 1000) + 1000);
	expect((await navigationCounts(owner, "mailbox")).folders.snoozed.total).toBe(
		1,
	);
	expect(
		(await navigationCounts(owner, "mailbox")).customFolders[folder.id],
	).toBeUndefined();
	expect(own.status).toBe("draft");
});
test("folder creation preserves Mailflare colors, mailbox ownership and duplicate rejection", async () => {
	const folder = await createFolder(owner, {
		mailboxId: "mailbox",
		name: "Work",
		color: "#db2777",
	});
	expect(folder.color).toBe("#db2777");
	await expect(
		createFolder(owner, { mailboxId: "mailbox", name: "Work" }),
	).rejects.toThrow("already exists");
	await expect(
		createFolder(stranger, { mailboxId: "mailbox", name: "Other" }),
	).rejects.toThrow("permission");
	await expect(
		createFolder(owner, {
			mailboxId: "mailbox",
			name: "Unsafe",
			color: "red;display:none",
		}),
	).rejects.toThrow();
});
test("drag moves cannot change another user's mailbox or attach a foreign folder", async () => {
	const folder = await createFolder(owner, {
		mailboxId: "mailbox",
		name: "Work",
	});
	await expect(
		moveMessages(stranger, {
			messageIds: ["message"],
			action: "folder",
			folderId: folder.id,
		}),
	).rejects.toThrow("accessible");
	state.db.exec(
		"INSERT INTO domains (id,user_id,hostname,zone_id,status,created_at) VALUES ('foreign','stranger','foreign.example','zone','active',1); INSERT INTO mailboxes (id,user_id,domain_id,local_part,created_at) VALUES ('foreign','stranger','foreign','mail',1); INSERT INTO folders (id,user_id,mailbox_id,name,color,created_at) VALUES ('foreign','stranger','foreign','Foreign','#2563eb',1)",
	);
	await expect(
		moveMessages(owner, {
			messageIds: ["message"],
			action: "folder",
			folderId: "foreign",
		}),
	).rejects.toThrow("accessible");
	await moveMessages(owner, { messageIds: ["message"], action: "trash" });
	expect((await navigationCounts(owner, "mailbox")).folders.trash.total).toBe(
		1,
	);
});
test("keyboard shortcut preferences are persisted per account", async () => {
	expect((await shortcutSettings(owner)).enabled).toBe(true);
	await shortcutSettings(owner, false);
	expect((await shortcutSettings(owner)).enabled).toBe(false);
	expect((await shortcutSettings(stranger)).enabled).toBe(true);
});
test("saved Mailflare navigation order retains new items once and supports moving between sections", () => {
	const layout = resolveLayout(
		{ main: ["inbox", "starred"], more: ["drafts", "trash"] },
		{ main: ["trash", "trash", "removed"], more: ["inbox"] },
	);
	expect(layout).toEqual({
		main: ["trash", "starred"],
		more: ["inbox", "drafts"],
	});
	expect(moveItem(layout, "drafts", "main", "starred")).toEqual({
		main: ["trash", "drafts", "starred"],
		more: ["inbox"],
	});
});
