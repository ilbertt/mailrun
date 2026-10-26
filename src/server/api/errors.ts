import { z } from "zod";
export async function apiErrorResponse(error: unknown): Promise<Response> {
	if (error instanceof Response)
		return Response.json(
			{ error: await error.text() },
			{ status: error.status },
		);
	if (error instanceof Error && error.message.startsWith("Too many"))
		return Response.json({ error: error.message }, { status: 429 });
	if (error instanceof Error && error.message === "Message too large")
		return Response.json({ error: "Request body too large" }, { status: 413 });
	if (error instanceof SyntaxError)
		return Response.json({ error: "Invalid JSON request" }, { status: 400 });
	if (error instanceof z.ZodError)
		return Response.json(
			{ error: "Invalid request", details: error.flatten() },
			{ status: 400 },
		);
	if (
		error instanceof Error &&
		/draft changed|another tab|no longer editable|is being saved/.test(
			error.message,
		)
	)
		return Response.json({ error: error.message }, { status: 409 });
	if (error instanceof Error && error.message === "Folder already exists")
		return Response.json({ error: error.message }, { status: 409 });
	if (
		error instanceof Error &&
		/not found or permission denied|Draft not found/.test(error.message)
	)
		return Response.json({ error: "Not found" }, { status: 404 });
	console.error("Mail API request failed", error);
	return Response.json({ error: "Request failed" }, { status: 500 });
}
