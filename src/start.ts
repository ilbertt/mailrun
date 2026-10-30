import { createStart } from "@tanstack/react-start";
import { sessionServerFetch } from "./lib/auth/client";

export const startInstance = createStart(() => ({
	serverFns: { fetch: sessionServerFetch },
}));
