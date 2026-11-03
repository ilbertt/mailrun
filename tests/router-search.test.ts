import { expect, test } from "bun:test";
import {
	parseRouteSearch,
	stringifyRouteSearch,
} from "../src/lib/router-search";

test("source URL flags, numeric IDs, JSON-looking search and tokens retain their text", () => {
	const source = new URLSearchParams({
		add: "1",
		mailboxId: "123",
		q: '{"from":"person@example.com"}',
		token: "false",
		folder: "null",
		types: "1,2",
		empty: "",
	});
	const parsed = parseRouteSearch(`?${source}`);
	for (const key of source.keys()) expect(parsed[key]).toBe(source.get(key)!);
	expect(stringifyRouteSearch(parsed)).toBe(`?${source}`);
	expect(parseRouteSearch("?q=%221%22&token=1e0&folder=0001")).toEqual({
		q: '"1"',
		token: "1e0",
		folder: "0001",
	});
	expect(stringifyRouteSearch({ add: "1", removed: undefined })).toBe("?add=1");
	expect(stringifyRouteSearch({})).toBe("");
});

test("duplicate parameters use the source's first value and reserved object keys stay inert", () => {
	const parsed = parseRouteSearch(
		"?add=1&add=0&__proto__=text&constructor=plain",
	);
	expect(parsed.add).toBe("1");
	expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
	expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
	expect(parsed.__proto__).toBe("text");
	expect(Object.entries(parsed)).toContainEqual(["constructor", "plain"]);
});
