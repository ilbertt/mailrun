import { queryOptions } from "@tanstack/react-query";
import {
	sessionFn,
	mailboxesFn,
	messagesFn,
	threadFn,
	mailSettingsFn,
	localeFn,
} from "./functions";
import type { ListInput } from "./shared/contracts";
import { documentCacheOptions } from "./query-client";

export const documentQuery = () =>
	queryOptions({
		...documentCacheOptions,
		queryFn: () => localeFn(),
	});

export const sessionQuery = () =>
	queryOptions({
		queryKey: ["session"],
		queryFn: () => sessionFn(),
		staleTime: 60_000,
		retry: false,
	});
export const mailboxesQuery = (userId: string) =>
	queryOptions({
		queryKey: ["mailboxes", userId],
		queryFn: () => mailboxesFn(),
		staleTime: 60_000,
	});
export const messagesQuery = (userId: string, input: ListInput) =>
	queryOptions({
		queryKey: ["messages", userId, input],
		queryFn: ({ signal }) => messagesFn({ data: input, signal }),
		staleTime: 30_000,
	});
export const threadQuery = (userId: string, id: string) =>
	queryOptions({
		queryKey: ["thread", userId, id],
		queryFn: ({ signal }) => threadFn({ data: { id }, signal }),
		staleTime: 60_000,
	});
export const mailSettingsQuery = (userId: string) =>
	queryOptions({
		queryKey: ["mail-settings", userId],
		queryFn: () => mailSettingsFn(),
		staleTime: 30000,
	});
