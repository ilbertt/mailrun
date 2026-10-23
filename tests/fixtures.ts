import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/server/db";
import type { User } from "../src/shared/contracts";

export const owner: User = {
	id: "owner",
	email: "owner@example.com",
	name: "Owner",
	role: "admin",
	isPrimaryAdmin: true,
};
export const stranger: User = {
	id: "stranger",
	email: "stranger@example.com",
	name: "Stranger",
	role: "user",
	isPrimaryAdmin: false,
};
export async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "mailrun-test-"));
	const old = process.env.DATA_DIR;
	const oldNibrun = process.env.NIBRUN_DATA_DIR;
	delete process.env.NIBRUN_DATA_DIR;
	process.env.DATA_DIR = directory;
	const path = join(directory, "mailflare.sqlite");
	await migrate(path);
	const db = new Database(path);
	db.exec("PRAGMA foreign_keys=ON");
	for (const user of [owner, stranger])
		db.query(
			"INSERT INTO users (id,email,name,password_hash,role,is_primary_admin,created_at) VALUES (?,?,?,?,?,?,?)",
		).run(
			user.id,
			user.email,
			user.name,
			"test-only",
			user.role,
			user.isPrimaryAdmin ? 1 : 0,
			1,
		);
	db.query(
		"INSERT INTO domains (id,user_id,hostname,zone_id,status,sending_enabled,created_at) VALUES ('domain','owner','example.com','zone','active',1,1)",
	).run();
	db.query(
		"INSERT INTO mailboxes (id,user_id,domain_id,local_part,created_at) VALUES ('mailbox','owner','domain','hello',1)",
	).run();
	db.query(
		"INSERT INTO messages (id,user_id,mailbox_id,direction,from_addr,to_addr,subject,snippet,text_body,created_at) VALUES ('message','owner','mailbox','inbound','sender@example.org','hello@example.com','A searchable subject','Welcome','Welcome to Mailrun',1)",
	).run();
	return {
		directory,
		path,
		db,
		async close() {
			db.close();
			if (old === undefined) delete process.env.DATA_DIR;
			else process.env.DATA_DIR = old;
			if (oldNibrun === undefined) delete process.env.NIBRUN_DATA_DIR;
			else process.env.NIBRUN_DATA_DIR = oldNibrun;
			await rm(directory, { recursive: true, force: true });
		},
	};
}
