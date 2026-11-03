import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";

export function dataDirectory() {
	const path = resolve(process.env.NIBRUN_DATA_DIR ?? process.env.DATA_DIR ?? "./data");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

export function publicOrigin() {
	const value = process.env.APP_URL ?? (process.env.NIBRUN_HOSTNAME
		? `https://${process.env.NIBRUN_HOSTNAME}` : `http://localhost:${process.env.PORT ?? "3000"}`);
	const url = new URL(z.url().parse(value));
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid APP_URL");
	return url.origin;
}
