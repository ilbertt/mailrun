import { z } from "zod";
import type { User } from "../../shared/contracts";
import { licenseStatus, updateLicense } from "../licenses";
import { readLimitedBody } from "../mail/inbound";
import { publicOrigin } from "../config";
export async function licensesApi(
	request: Request,
	user: User,
): Promise<Response | null> {
	const path = new URL(request.url).pathname,
		method = request.method;
	if (!/^\/api\/licenses(?:\/(activate|validate|deactivate))?$/.test(path))
		return null;
	if (user.role !== "admin" || !user.isPrimaryAdmin)
		throw new Response("Forbidden", { status: 403 });
	if (path === "/api/licenses" && method === "GET")
		return Response.json(
			{ license: await licenseStatus() },
			{ headers: { "Cache-Control": "no-store" } },
		);
	if (method !== "POST") return null;
	const input = z
		.object({
			licenseKey: z.string().trim().max(500).default(""),
			plan: z.enum(["pro", "team"]).optional(),
		})
		.parse(
			JSON.parse(
				new TextDecoder().decode(await readLimitedBody(request, 16 * 1024)),
			),
		);
	const action = z
		.enum(["activate", "validate", "deactivate"])
		.parse(path.split("/").at(-1));
	if (action !== "deactivate" && !input.licenseKey)
		throw new Response("Enter a license key", { status: 400 });
	if (action === "activate" && !input.plan)
		throw new Response("Choose Pro or Team", { status: 400 });
	try {
		return Response.json({
			license: await updateLicense(
				action,
				input.licenseKey,
				publicOrigin(),
				input.plan,
			),
		});
	} catch (error) {
		throw new Response(
			error instanceof Error ? error.message : "Unable to update license",
			{ status: 400 },
		);
	}
}
