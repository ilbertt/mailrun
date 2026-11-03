import { AsyncResource } from "node:async_hooks";
import { runWebhookJobs, type WebhookFetch } from "./delivery";
declare global {
	var __mailrunWebhookWake: (() => void) | undefined;
}
export function wakeWebhookDispatcher() {
	globalThis.__mailrunWebhookWake?.();
}
// Created at Bun startup, outside Start's request context. The worker retains only
// persisted delivery IDs, rather than MIME/upload bodies or a request's ALS stores.
export function startWebhookDispatcher(send: WebhookFetch = fetch) {
	if (globalThis.__mailrunWebhookWake)
		throw new Error("Webhook dispatcher already started");
	const context = new AsyncResource("mailrun-webhooks");
	let running: Promise<void> | undefined,
		wanted = false,
		stopped = false;
	const wake = () =>
		context.runInAsyncScope(() => {
			if (stopped) return;
			wanted = true;
			if (running) return;
			running = (async () => {
				do {
					wanted = false;
					if ((await runWebhookJobs(send)) >= 20) wanted = true;
				} while (wanted && !stopped);
			})()
				.catch((error) => console.error("Webhook dispatcher failed", error))
				.finally(() => {
					running = undefined;
					if (wanted && !stopped) wake();
				});
		});
	globalThis.__mailrunWebhookWake = wake;
	wake();
	return async () => {
		stopped = true;
		if (globalThis.__mailrunWebhookWake === wake)
			globalThis.__mailrunWebhookWake = undefined;
		await running;
		context.emitDestroy();
	};
}
