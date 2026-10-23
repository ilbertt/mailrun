import { createFileRoute } from "@tanstack/react-router";
import { MessageFolderPage } from "../components/message-folder-page";
import { listInputSchema } from "../shared/contracts";
import { mailboxesQuery, messagesQuery } from "../queries";
export const Route = createFileRoute("/_mail/folders/$folderId")({
	validateSearch: listInputSchema,
	loaderDeps: ({ search }) => search,
	loader: async ({ context, params, deps }) => {
		const mailboxes = await context.queryClient.ensureQueryData(
			mailboxesQuery(context.user.id),
		);
		await context.queryClient.ensureQueryData(
			messagesQuery(context.user.id, {
				...deps,
				folder: "inbox",
				folderId: params.folderId,
				mailboxId: deps.mailboxId ?? mailboxes[0]?.id,
			}),
		);
	},
	component: () => (
		<MessageFolderPage folder="inbox" folderId={Route.useParams().folderId} />
	),
});
