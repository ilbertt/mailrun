import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { fixture } from "./fixtures";
import { withDatabase } from "../src/server/db";
test("separate compiled bundles serialize SQLite callbacks in the same process", async () => {
	const state = await fixture();
	let release = () => {};
	let entered = () => {};
	const gate = new Promise<void>((resolve) => {
			release = resolve;
		}),
		ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
	try {
		const result = await Bun.build({
			entrypoints: [resolve("src/server/db.ts")],
			target: "bun",
		});
		if (!result.success || !result.outputs[0])
			throw new Error("Could not build an independent database bundle");
		const path = join(state.directory, "db-copy.mjs");
		await Bun.write(path, result.outputs[0]);
		const copy: typeof import("../src/server/db") = await import(path);
		expect(copy.withDatabase).not.toBe(withDatabase);
		const first = withDatabase(async () => {
			entered();
			await gate;
		});
		await ready;
		let started = false;
		const second = copy.withDatabase(async () => {
			started = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(started).toBe(false);
		} finally {
			release();
			await Promise.all([first, second]);
		}
		expect(started).toBe(true);
	} finally {
		release();
		await state.close();
	}
});
