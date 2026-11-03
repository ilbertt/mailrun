import type { User } from "../../shared/contracts";
import type { ApiPrincipal } from "../../server/auth/key-principal";

export type CalendarToolContext = {
	signal?: AbortSignal;
	actor?: ApiPrincipal;
	user: User;
	timeZone?: string;
};
export type CalendarToolName =
	| "get_schedule"
	| "search_events"
	| "get_event"
	| "create_event"
	| "update_events"
	| "delete_events"
	| "find_free_time"
	| "get_calendars";
