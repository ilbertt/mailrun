import { queryOptions } from "@tanstack/react-query";
import { sessionFn, mailboxesFn, messagesFn, threadFn } from "./functions";
import type { ListInput } from "./shared/contracts";

export const sessionQuery = () => queryOptions({ queryKey: ["session"], queryFn: () => sessionFn(), staleTime: 60_000, retry: false });
export const mailboxesQuery = (userId: string) => queryOptions({ queryKey: ["mailboxes", userId], queryFn: () => mailboxesFn(), staleTime: 60_000 });
export const messagesQuery = (userId: string, input: ListInput) => queryOptions({
	queryKey: ["messages", userId, input], queryFn: ({ signal }) => messagesFn({ data: input, signal }), staleTime: 30_000,
});
export const threadQuery = (userId: string, id: string) => queryOptions({
	queryKey: ["thread", userId, id], queryFn: ({ signal }) => threadFn({ data: { id }, signal }), staleTime: 60_000,
});
