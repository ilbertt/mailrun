// Contract of the TanStack Start build consumed by the native Bun launcher.
declare module "#start-handler" {
	const handler: { fetch(request: Request): Promise<Response> };
	export default handler;
}
