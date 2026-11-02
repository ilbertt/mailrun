import { test, expect } from "bun:test";
import {
	routingRegexMatches,
	RoutingRegexError,
} from "../src/server/mail/regex-execution";

test("routing regex retains valid nested patterns, backreferences, complete input and syntax failure", async () => {
	expect(await routingRegexMatches("(a+)+$", "aaaa")).toBe(true);
	expect(await routingRegexMatches("^(a+)\\1$", "aaaa")).toBe(true);
	expect(await routingRegexMatches("end$", "x".repeat(10010) + "end")).toBe(
		true,
	);
	expect(await routingRegexMatches("[", "x")).toBe(false);
	expect(
		await routingRegexMatches("^" + "x".repeat(300) + "$", "x".repeat(300)),
	).toBe(true);
});
test("expensive routing regex is killed without blocking the event loop and a subsequent match succeeds", async () => {
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 10);
	const start = performance.now();
	try {
		await expect(
			routingRegexMatches("(a+)+$", "a".repeat(30000) + "!"),
		).rejects.toBeInstanceOf(RoutingRegexError);
	} finally {
		clearInterval(timer);
	}
	expect(performance.now() - start).toBeLessThan(5000);
	expect(ticks).toBeGreaterThan(1);
	expect(await routingRegexMatches("(a+)+$", "aaaa")).toBe(true);
});
test("isolated regex framing preserves non-BMP and unpaired UTF-16 code units", async () => {
	const value = "x".repeat(32767) + "😀\ud800";
	expect(await routingRegexMatches("^(x+)+(😀)\ud800$", value)).toBe(true);
});
