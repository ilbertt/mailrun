import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
	define: {
		"process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY": JSON.stringify(
			process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
		),
	},
	resolve: {
		alias: [
			{ find: "@", replacement: new URL("./src", import.meta.url).pathname },
			{ find: /^css-tree$/, replacement: "css-tree/dist/csstree.esm" },
		],
	},
	ssr: {
		resolve: {
			conditions: ["bun", "module", "node", "development|production"],
		},
		external: ["bun", "bun:sqlite"],
		noExternal: ["@ilbertt/bun-sqlgen"],
	},
	plugins: [tailwind(), tanstackStart(), react()],
});
