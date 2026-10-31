import { expect, test } from "bun:test";
import { dehydrate, hydrate } from "@tanstack/react-query";
import {
	createAppQueryClient,
	documentCacheOptions,
} from "../src/query-client";

test("hydrated document preferences retain their lifetime and navigation reuses them until explicitly cleared", async () => {
	const server = createAppQueryClient(),
		browser = createAppQueryClient();
	try {
		await server.fetchQuery({
			...documentCacheOptions,
			queryFn: async () => ({ locale: "en", appName: "Fixture" }),
		});
		hydrate(browser, dehydrate(server));
		expect(
			browser.getQueryCache().find({ queryKey: documentCacheOptions.queryKey })
				?.gcTime,
		).toBe(Infinity);
		let requests = 0;
		const query = {
			...documentCacheOptions,
			queryFn: async () => {
				requests++;
				return { locale: "it", appName: "Updated" };
			},
		};
		for (let i = 0; i < 5; i++)
			expect(await browser.ensureQueryData(query)).toEqual({
				locale: "en",
				appName: "Fixture",
			});
		expect(requests).toBe(0);
		browser.removeQueries({ queryKey: documentCacheOptions.queryKey });
		expect(await browser.ensureQueryData(query)).toEqual({
			locale: "it",
			appName: "Updated",
		});
		expect(requests).toBe(1);
		browser.clear();
		await browser.ensureQueryData(query);
		expect(requests).toBe(2);
	} finally {
		server.clear();
		browser.clear();
	}
});

test("document caches are isolated between router instances", async () => {
	const first = createAppQueryClient(),
		second = createAppQueryClient();
	try {
		await first.ensureQueryData({
			...documentCacheOptions,
			queryFn: async () => "Italian visitor",
		});
		expect(second.getQueryData(documentCacheOptions.queryKey)).toBeUndefined();
		expect(
			await second.ensureQueryData({
				...documentCacheOptions,
				queryFn: async () => "English visitor",
			}),
		).toBe("English visitor");
		expect(first.getQueryData(documentCacheOptions.queryKey)).toBe(
			"Italian visitor",
		);
	} finally {
		first.clear();
		second.clear();
	}
});
