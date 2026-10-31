import MessageDetailPage from "../app/(dashboard)/inbox/[messageId]/page";
export function Conversation({ messageId }: { messageId: string }) {
	return <MessageDetailPage messageId={messageId} />;
}
