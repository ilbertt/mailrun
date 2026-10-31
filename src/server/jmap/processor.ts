import {
	CAPABILITY_CORE,
	CAPABILITY_MAIL,
	CAPABILITY_SUBMISSION,
	LIMITS,
} from "./constants";
import { JmapError } from "./errors";
import {
	mailboxChanges,
	mailboxGet,
	mailboxQuery,
	mailboxSet,
} from "./mailboxes";
import {
	emailChanges,
	emailGet,
	emailImport,
	emailQuery,
	emailQueryChanges,
	emailSet,
	emailUnsupported,
	searchSnippetGet,
	threadChanges,
	threadGet,
} from "./emails";
import {
	emailSubmissionChanges,
	emailSubmissionGet,
	emailSubmissionQuery,
	emailSubmissionSet,
	identityChanges,
	identityGet,
	identitySet,
} from "./identities";
import { getEmailState } from "./state";
import type {
	JmapContext,
	JmapInvocation,
	JmapMethodHandler,
	JmapRequest,
	JmapResponse,
} from "./types";

const METHODS: Record<string, JmapMethodHandler> = {
	"Core/echo": async (_ctx, args) => args,
	"Mailbox/get": mailboxGet,
	"Mailbox/query": mailboxQuery,
	"Mailbox/changes": mailboxChanges,
	"Mailbox/queryChanges": async () => ({ type: "cannotCalculateChanges" }),
	"Mailbox/set": mailboxSet,
	"Thread/get": threadGet,
	"Thread/changes": threadChanges,
	"Email/get": emailGet,
	"Email/query": emailQuery,
	"Email/changes": emailChanges,
	"Email/queryChanges": emailQueryChanges,
	"Email/set": emailSet,
	"Email/copy": emailUnsupported("Email/copy"),
	"Email/import": emailImport,
	"Email/parse": emailUnsupported("Email/parse"),
	"SearchSnippet/get": searchSnippetGet,
	"Identity/get": identityGet,
	"Identity/changes": identityChanges,
	"Identity/set": identitySet,
	"EmailSubmission/get": emailSubmissionGet,
	"EmailSubmission/query": emailSubmissionQuery,
	"EmailSubmission/changes": emailSubmissionChanges,
	"EmailSubmission/queryChanges": async () => ({
		type: "cannotCalculateChanges",
	}),
	"EmailSubmission/set": emailSubmissionSet,
};

export const SUPPORTED_CAPABILITIES = new Set([
	CAPABILITY_CORE,
	CAPABILITY_MAIL,
	CAPABILITY_SUBMISSION,
]);

/** JSON Pointer lookup with the JMAP `*` array-flattening extension. */
function resolvePointer(value: unknown, path: string): unknown {
	const segments = path
		.split("/")
		.slice(1)
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
	let current: unknown = value;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index]!;
		if (segment === "*" && Array.isArray(current)) {
			const rest = `/${segments.slice(index + 1).join("/")}`;
			return current.flatMap((item) => {
				const resolved =
					segments.length > index + 1 ? resolvePointer(item, rest) : item;
				return Array.isArray(resolved) ? resolved : [resolved];
			});
		}
		if (current === null || typeof current !== "object")
			throw new JmapError("invalidResultReference", `Path ${path} not found`);
		if (!Object.hasOwn(current, segment))
			throw new JmapError("invalidResultReference", `Path ${path} not found`);
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** Replace `#arg` result references with values from earlier responses. */
function resolveReferences(
	args: Record<string, unknown>,
	responses: JmapInvocation[],
): Record<string, unknown> {
	const resolved: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(args)) {
		if (!key.startsWith("#")) {
			resolved[key] = value;
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new JmapError("invalidResultReference");
		const ref = value as Record<string, unknown>;
		if (
			typeof ref.resultOf !== "string" ||
			typeof ref.name !== "string" ||
			typeof ref.path !== "string" ||
			!ref.path.startsWith("/") ||
			Object.hasOwn(args, key.slice(1))
		)
			throw new JmapError("invalidResultReference");
		const source = responses.find(
			([name, , callId]) => callId === ref.resultOf && name === ref.name,
		);
		if (!source)
			throw new JmapError(
				"invalidResultReference",
				`No response ${ref.name} for call ${ref.resultOf}`,
			);
		resolved[key.slice(1)] = resolvePointer(source[1], ref.path);
	}
	return resolved;
}

/** Client creation ids (`#draft1`) become server ids once the create has run. */
function resolveCreatedIds(
	args: Record<string, unknown>,
	createdIds: Record<string, string>,
): Record<string, unknown> {
	const walk = (value: unknown, depth = 0): unknown => {
		if (depth > 100)
			throw new JmapError("invalidArguments", "Argument nesting is too deep");
		if (
			typeof value === "string" &&
			value.startsWith("#") &&
			createdIds[value.slice(1)]
		)
			return createdIds[value.slice(1)];
		if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, walk(v, depth + 1)]),
			);
		return value;
	};
	return walk(args) as Record<string, unknown>;
}

export async function processRequest(
	ctx: JmapContext,
	request: JmapRequest,
): Promise<JmapResponse> {
	const responses: JmapInvocation[] = [];
	Object.assign(ctx.createdIds, request.createdIds ?? {});

	for (const [name, rawArgs, callId] of request.methodCalls) {
		const handler = Object.hasOwn(METHODS, name) ? METHODS[name] : undefined;
		if (!handler) {
			responses.push(["error", { type: "unknownMethod" }, callId]);
			continue;
		}
		try {
			const args = resolveCreatedIds(
				resolveReferences(rawArgs ?? {}, responses),
				ctx.createdIds,
			);
			validateArguments(name, args);
			if (
				args.accountId !== undefined &&
				args.accountId !== ctx.accountId &&
				name !== "Core/echo"
			) {
				responses.push(["error", { type: "accountNotFound" }, callId]);
				continue;
			}
			const result = await handler(ctx, args);
			if (
				"type" in result &&
				typeof result.type === "string" &&
				!("accountId" in result) &&
				!("list" in result)
			) {
				responses.push(["error", result, callId]);
				continue;
			}
			const { __destroyedEmails, ...clean } = result as Record<
				string,
				unknown
			> & { __destroyedEmails?: string[] };
			responses.push([name, clean, callId]);
			// A successful submission removed the draft: report it the way RFC 8621 §7.5 describes.
			if (name === "EmailSubmission/set" && __destroyedEmails?.length) {
				responses.push([
					"Email/set",
					{
						accountId: ctx.accountId,
						oldState: clean.oldState,
						newState: clean.newState,
						updated: {},
						destroyed: __destroyedEmails,
						created: {},
					},
					callId,
				]);
			}
		} catch (error) {
			if (error instanceof JmapError) {
				responses.push(["error", error.toMethodError(), callId]);
			} else {
				console.error(`JMAP ${name} failed`, error);
				responses.push([
					"error",
					{
						type: "serverFail",
						description:
							error instanceof Error ? error.message : "Unexpected error",
					},
					callId,
				]);
			}
		}
	}

	return {
		methodResponses: responses,
		createdIds: Object.keys(ctx.createdIds).length ? ctx.createdIds : undefined,
		sessionState: await sessionState(ctx),
	};
}

function validateArguments(name: string, args: Record<string, unknown>) {
	if (name === "Core/echo") return;
	const object = (value: unknown) =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	for (const field of ["ids", "emailIds", "properties", "destroy"]) {
		const value = args[field];
		if (value == null) continue;
		if (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
			throw new JmapError(
				"invalidArguments",
				`${field} must be an array of strings`,
			);
		if (
			field !== "properties" &&
			value.length >
				(field === "destroy" ? LIMITS.maxObjectsInSet : LIMITS.maxObjectsInGet)
		)
			throw new JmapError("requestTooLarge");
	}
	for (const field of ["create", "update", "emails"]) {
		const value = args[field];
		if (value == null) continue;
		if (!object(value) || Object.values(value).some((item) => !object(item)))
			throw new JmapError(
				"invalidArguments",
				`${field} must map ids to objects`,
			);
	}
	if (name.endsWith("/set")) {
		const count =
			Object.keys(args.create ?? {}).length +
			Object.keys(args.update ?? {}).length +
			(Array.isArray(args.destroy) ? args.destroy.length : 0);
		if (count > LIMITS.maxObjectsInSet) throw new JmapError("requestTooLarge");
	}
	if (args.filter != null && !object(args.filter))
		throw new JmapError("invalidArguments", "filter must be an object");
	if (
		args.sort != null &&
		(!Array.isArray(args.sort) || args.sort.some((item) => !object(item)))
	)
		throw new JmapError("invalidArguments", "sort must be an array of objects");
	for (const field of [
		"position",
		"limit",
		"anchorOffset",
		"maxBodyValueBytes",
	]) {
		const value = args[field];
		if (
			value != null &&
			(typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				((field === "limit" || field === "maxBodyValueBytes") && value < 0))
		)
			throw new JmapError("invalidArguments", `Invalid ${field}`);
	}
}

export async function sessionState(ctx: JmapContext): Promise<string> {
	return getEmailState(ctx);
}

export function validateRequest(body: unknown): JmapRequest {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new JmapError("notRequest");
	const request = body as Partial<JmapRequest>;
	if (!Array.isArray(request.using) || !Array.isArray(request.methodCalls))
		throw new JmapError("notRequest");
	for (const capability of request.using) {
		if (
			typeof capability !== "string" ||
			!SUPPORTED_CAPABILITIES.has(capability)
		)
			throw new JmapError("unknownCapability", String(capability));
	}
	if (request.methodCalls.length > LIMITS.maxCallsInRequest)
		throw new JmapError("limit", "Too many method calls", {
			limit: "maxCallsInRequest",
		});
	for (const call of request.methodCalls) {
		if (
			!Array.isArray(call) ||
			call.length !== 3 ||
			typeof call[0] !== "string" ||
			!call[1] ||
			typeof call[1] !== "object" ||
			Array.isArray(call[1]) ||
			typeof call[2] !== "string"
		)
			throw new JmapError("notRequest");
	}
	if (
		request.createdIds !== undefined &&
		(!request.createdIds ||
			typeof request.createdIds !== "object" ||
			Array.isArray(request.createdIds) ||
			Object.values(request.createdIds).some(
				(value) => typeof value !== "string",
			))
	)
		throw new JmapError("notRequest");
	return request as JmapRequest;
}
