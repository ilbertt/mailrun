import { createFileRoute } from "@tanstack/react-router";
import { listInputSchema } from "../shared/contracts";
import { mailboxesQuery, messagesQuery } from "../queries";
import { MessageFolderPage } from "../components/message-folder-page";
export const Route = createFileRoute("/_mail/snoozed")({
	validateSearch: listInputSchema,
	loaderDeps: ({ search }) => ({ ...search, folder: "snoozed" as const }),
	loader: async ({ context, deps }) => {
		const mailboxes = await context.queryClient.ensureQueryData(
			mailboxesQuery(context.user.id),
		);
		await context.queryClient.ensureQueryData(
			messagesQuery(context.user.id, {
				...deps,
				mailboxId: deps.mailboxId ?? mailboxes[0]?.id,
			}),
		);
	},
	component: () => <MessageFolderPage folder="snoozed" />,
});
