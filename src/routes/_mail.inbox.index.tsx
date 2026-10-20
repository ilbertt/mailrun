import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_mail/inbox/")({ component: () => <section className="reading-pane empty"><span className="empty-icon">↗</span><p>Select a conversation</p></section> });
