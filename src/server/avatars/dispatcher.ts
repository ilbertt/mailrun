import { AsyncResource } from "node:async_hooks";
import type { CloudflareFetch } from "../cloudflare/client";
import { runAvatarJobs } from "./jobs";
declare global {
	var __mailrunAvatarWake: (() => void) | undefined;
}
export const wakeAvatarDispatcher = () => globalThis.__mailrunAvatarWake?.();
export function startAvatarDispatcher(send: CloudflareFetch = fetch) {
	if (globalThis.__mailrunAvatarWake)
		throw new Error("Avatar dispatcher already started");
	const resource = new AsyncResource("mailrun-contact-avatars"),
		controller = new AbortController();
	let running: Promise<void> | undefined,
		wanted = false,
		stopped = false;
	const wake = () =>
		resource.runInAsyncScope(() => {
			if (stopped) return;
			wanted = true;
			if (running) return;
			running = (async () => {
				do {
					wanted = false;
					if ((await runAvatarJobs(send, controller.signal)) >= 5)
						wanted = true;
				} while (wanted && !stopped);
			})()
				.catch(() => console.warn("Avatar dispatcher failed"))
				.finally(() => {
					running = undefined;
					if (wanted && !stopped) wake();
				});
		});
	globalThis.__mailrunAvatarWake = wake;
	wake();
	return async () => {
		stopped = true;
		controller.abort();
		if (globalThis.__mailrunAvatarWake === wake)
			globalThis.__mailrunAvatarWake = undefined;
		await running;
		resource.emitDestroy();
	};
}
