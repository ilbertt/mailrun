export function expectedDraftRevision(request: Request, current: number) {
	const match = request.headers.get("if-match");
	if (!match) return current;
	const value = /^"(\d+)"$/.exec(match)?.[1];
	if (!value || !Number.isSafeInteger(Number(value)))
		throw new Response("Invalid draft revision", { status: 412 });
	if (Number(value) !== current)
		throw new Response(
			"This draft changed in another tab. Reopen it before saving.",
			{ status: 409 },
		);
	return Number(value);
}
