export type CalendarRepeat =
	| "none"
	| "daily"
	| "weekly"
	| "monthly"
	| "weekdays";

export type CalendarEventRecord = {
	id: string;
	userId: string;
	mailboxId: string | null;
	title: string;
	description: string;
	location: string;
	attendees: string;
	color: string;
	repeat: CalendarRepeat;
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	excludedOccurrences: string;
	timeZone: string | null;
	startsAt: Date;
	endsAt: Date;
	createdAt: Date;
	updatedAt: Date;
};
