export function parseBookingGuestEmails(
	value: unknown,
	bookerEmail: string,
): string[] | null {
	if (value === undefined || value === "") return [];
	if (typeof value !== "string" || value.length > 2000) return null;
	const emails = value
		.split(",")
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
	if (
		emails.length > 20 ||
		emails.some((email) => email.length > 254 || !/^\S+@\S+\.\S+$/.test(email))
	)
		return null;
	return [...new Set(emails.filter((email) => email !== bookerEmail))];
}
