import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
	ssr: {
		resolve: { conditions: ["bun", "module", "node", "development|production"] },
		external: ["bun", "bun:sqlite"],
		noExternal: ["@ilbertt/bun-sqlgen"],
	},
	plugins: [tanstackStart(), react()],
});
