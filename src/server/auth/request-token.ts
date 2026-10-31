export function sessionToken(request: Request) {
	return (
		request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ??
		request.headers.get("cookie")?.match(/(?:^|;\s*)ep_session=([^;]+)/)?.[1]
	);
}
