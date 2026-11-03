import { open } from "node:fs/promises";

/** Linux needs a directory fsync as well as the file fsync to persist a name. */
export async function syncDirectory(path: string, missingOK = false) {
	// The deployed runtime is Linux. Other supported hosts remain usable for
	// development without claiming identical filesystem crash guarantees.
	if (process.platform !== "linux") return;
	const directory = await open(path, "r").catch((error) => {
		if (
			missingOK &&
			error instanceof Error &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return null;
		throw error;
	});
	if (!directory) return;
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
