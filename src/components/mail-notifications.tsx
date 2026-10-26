import { useMessagePolling } from "../hooks/use-message-polling";
import { NewMessagePopup } from "./new-message-popup";
import { PwaServiceWorker } from "./pwa-service-worker";
export function MailNotifications() {
	const realtime = useMessagePolling();
	return (
		<>
			<PwaServiceWorker />
			<div role="status" aria-live="polite">
				{realtime.notification && (
					<NewMessagePopup
						notification={realtime.notification}
						onDismiss={realtime.dismissNotification}
					/>
				)}
			</div>
		</>
	);
}
