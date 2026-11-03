import type { routeSession } from "../../server/auth/route-session";
import {
	clientSessionScope,
	isCurrentClientSession,
	recordClientTransport,
	SessionUnauthorizedError,
} from "./client";

export type SessionSnapshot = Awaited<ReturnType<typeof routeSession>>;
export type RouteSessionState = SessionSnapshot & {
	verified: boolean;
	fromServer: boolean;
	checkedPath?: string;
};
const emptySession: SessionSnapshot = {
	user: null,
	timeZone: null,
	transport: null,
	needsSetup: false,
	needsOnboarding: false,
};

export async function probeRouteSession(
	read: (signal: AbortSignal) => Promise<SessionSnapshot>,
	options: {
		signal: AbortSignal;
		previous?: RouteSessionState;
		server?: boolean;
		timeoutMs?: number;
		isActive?: () => boolean;
	},
): Promise<RouteSessionState> {
	if (options.server)
		return {
			...(await read(options.signal)),
			verified: true,
			fromServer: true,
		};
	const scope = clientSessionScope();
	try {
		const signal = AbortSignal.any([
			options.signal,
			AbortSignal.timeout(options.timeoutMs ?? 5000),
		]);
		let aborted = () => {};
		const cancellation = new Promise<never>((_, reject) => {
			aborted = () =>
				reject(
					signal.reason ??
						new DOMException("Session probe cancelled", "AbortError"),
				);
			if (signal.aborted) aborted();
			else signal.addEventListener("abort", aborted, { once: true });
		});
		let session: SessionSnapshot;
		try {
			session = await Promise.race([read(signal), cancellation]);
		} finally {
			signal.removeEventListener("abort", aborted);
		}
		if (
			!isCurrentClientSession(scope) ||
			options.signal.aborted ||
			options.isActive?.() === false
		)
			throw new DOMException("Session probe cancelled", "AbortError");
		recordClientTransport(session.transport, scope, session.user?.id ?? null);
		return { ...session, verified: true, fromServer: false };
	} catch (error) {
		if (
			options.signal.aborted ||
			!isCurrentClientSession(scope) ||
			options.isActive?.() === false
		)
			throw error;
		if (
			error instanceof SessionUnauthorizedError ||
			(error instanceof Response && error.status === 401)
		)
			return { ...emptySession, verified: true, fromServer: false };
		// Like the source guard, a transient probe error does not discard the UI.
		// No identity or permission is invented; every backend operation reauthenticates.
		if (options.previous?.user)
			recordClientTransport(
				options.previous.transport,
				scope,
				options.previous.user.id,
			);
		return {
			...(options.previous ?? emptySession),
			verified: false,
			fromServer: false,
		};
	}
}
