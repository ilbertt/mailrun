import type { AgentFetch } from "./provider";
import { AsyncResource } from "node:async_hooks";
import { recoverAgentDraftJobs } from "./jobs";
declare global {
	var __mailrunAgentWake: (() => void) | undefined;
}
export function wakeAgentDispatcher() {
	globalThis.__mailrunAgentWake?.();
}
export function startAgentDispatcher(request: AgentFetch = fetch) {
	if (globalThis.__mailrunAgentWake)
		throw new Error("Agent dispatcher already started");
	const resource = new AsyncResource("mailrun-agent-drafts"),
		abort = new AbortController();
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
					if ((await recoverAgentDraftJobs(request, abort.signal)) >= 20)
						wanted = true;
				} while (wanted && !stopped);
			})()
				.catch((error) => console.error("Agent dispatcher failed", error))
				.finally(() => {
					running = undefined;
					if (wanted && !stopped) wake();
				});
		});
	globalThis.__mailrunAgentWake = wake;
	wake();
	return async () => {
		stopped = true;
		abort.abort();
		if (globalThis.__mailrunAgentWake === wake)
			globalThis.__mailrunAgentWake = undefined;
		await running;
		resource.emitDestroy();
	};
}
