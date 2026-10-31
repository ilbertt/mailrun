// Measurement only: real browser/keyboard actions still drive the application.
export {};
type FolderPath = "/inbox" | "/sent";
type PendingNavigation = { id: number; path: FolderPath; started: number };
let pending: PendingNavigation | undefined;
let sequence = 0;
let frameQueued = false;
const marker = document.createElement("meta");
marker.name = "mailrun-benchmark";
marker.dataset.count = "0";
document.head.append(marker);
function record(event: {
	kind: "start" | "done";
	id: number;
	path: FolderPath;
	elapsedMs?: number;
}) {
	void fetch("/_benchmark/event", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
	}).catch(() => {});
}
document.addEventListener(
	"click",
	(event) => {
		if (
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		)
			return;
		const anchor =
			event.target instanceof Element
				? event.target.closest<HTMLAnchorElement>("a[href]")
				: null;
		if (!anchor) return;
		const url = new URL(anchor.href, location.href),
			path = url.pathname;
		if (
			url.origin !== location.origin ||
			(path !== "/inbox" && path !== "/sent") ||
			path === location.pathname
		)
			return;
		pending = { id: ++sequence, path, started: performance.now() };
		record({ kind: "start", id: sequence, path });
	},
	true,
);
function visible(element: Element) {
	if (
		!element.getClientRects().length ||
		element.closest('[inert], [aria-hidden="true"]')
	)
		return false;
	for (
		let current: Element | null = element;
		current;
		current = current.parentElement
	) {
		const style = getComputedStyle(current);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			Number(style.opacity) === 0
		)
			return false;
	}
	return true;
}
function checkReady() {
	if (!pending || frameQueued) return;
	const current = pending,
		heading = document.querySelector("#main-content h1");
	const rowPath =
		current.path === "/inbox" ? "/inbox/bench-9999" : "/sent/sent-bench-99";
	if (
		location.pathname !== current.path ||
		heading?.textContent?.trim() !==
			(current.path === "/inbox" ? "Inbox" : "Sent")
	)
		return;
	if (
		!Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).some(
			(anchor) => new URL(anchor.href).pathname === rowPath && visible(anchor),
		)
	)
		return;
	frameQueued = true;
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			frameQueued = false;
			if (pending !== current) {
				checkReady();
				return;
			}
			const elapsedMs = performance.now() - current.started;
			marker.dataset.count = String(current.id);
			marker.dataset.elapsed = String(elapsedMs);
			record({ kind: "done", id: current.id, path: current.path, elapsedMs });
			pending = undefined;
		}),
	);
}
new MutationObserver(checkReady).observe(document, {
	subtree: true,
	childList: true,
	attributes: true,
	characterData: true,
});
window.addEventListener("popstate", checkReady);
