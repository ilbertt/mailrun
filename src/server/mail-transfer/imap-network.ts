import { lookup } from "node:dns/promises";
import { isIP, createConnection } from "node:net";
import { connect as connectTls } from "node:tls";
import { once } from "node:events";
export type ImapDialTarget = {
	address: string;
	family: number;
	host: string;
	port: number;
	secure: boolean;
	signal?: AbortSignal;
};
export type ImapTransport = {
	read: () => Promise<Uint8Array | null>;
	write: (value: Uint8Array) => Promise<void>;
	close: () => void;
};
export type ImapNetwork = {
	resolve: (host: string) => Promise<{ address: string; family: number }[]>;
	dial: (target: ImapDialTarget) => Promise<ImapTransport>;
};
export function isPublicImapAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const p = address.split(".").map(Number),
			a = p[0]!,
			b = p[1]!;
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 192 && b === 0 && p[2] === 0)
		);
	}
	if (isIP(address) !== 6) return false;
	const normalized = new URL(`http://[${address}]/`).hostname
		.slice(1, -1)
		.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		const parts = normalized.slice(7).split(":");
		if (parts.length !== 2) return false;
		const first = parseInt(parts[0]!, 16),
			last = parseInt(parts[1]!, 16);
		return isPublicImapAddress(
			`${first >> 8}.${first & 255}.${last >> 8}.${last & 255}`,
		);
	}
	const head = parseInt(normalized.split(":")[0]!, 16);
	return (
		head >= 0x2000 && head <= 0x3fff && !normalized.startsWith("2001:db8:")
	);
}
export function normalizeImapHost(value: string) {
	const host = value
		.trim()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (isIP(host)) return host;
	let url: URL;
	try {
		url = new URL("http://" + host);
	} catch {
		throw new Error("IMAP host is invalid");
	}
	if (
		url.username ||
		url.password ||
		url.port ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		!url.hostname
	)
		throw new Error("IMAP host is invalid");
	return url.hostname.toLowerCase();
}
export async function dialImapTransport(
	target: ImapDialTarget,
	trust?: { ca: string },
): Promise<ImapTransport> {
	const socket = target.secure
		? connectTls({
				host: target.address,
				port: target.port,
				servername: target.host,
				rejectUnauthorized: true,
				ca: trust?.ca,
			})
		: createConnection({
				host: target.address,
				port: target.port,
				family: target.family,
			});
	socket.on("error", () => {});
	const abort = () => socket.destroy(new Error("IMAP operation cancelled"));
	target.signal?.addEventListener("abort", abort, { once: true });
	const close = () => {
		target.signal?.removeEventListener("abort", abort);
		socket.destroy();
	};
	if (target.signal?.aborted) abort();
	socket.setTimeout(15_000, () =>
		socket.destroy(new Error("IMAP connection timed out")),
	);
	try {
		await once(socket, target.secure ? "secureConnect" : "connect");
	} catch (error) {
		close();
		throw error;
	}
	const iterator = socket[Symbol.asyncIterator]();
	return {
		async read() {
			const next = await iterator.next();
			if (next.done) return null;
			const value: unknown = next.value;
			if (!(value instanceof Uint8Array))
				throw new Error("Invalid IMAP socket data");
			return value;
		},
		async write(value) {
			if (!socket.write(value)) await once(socket, "drain");
		},
		close,
	};
}
const defaultNetwork: ImapNetwork = {
	resolve: (host) => lookup(host, { all: true }),
	dial: dialImapTransport,
};
export async function connectImap(
	input: { host: string; port: number; secure: boolean },
	network: ImapNetwork = defaultNetwork,
	signal?: AbortSignal,
) {
	if (signal?.aborted) throw new Error("IMAP operation cancelled");
	const host = normalizeImapHost(input.host);
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local")
	)
		throw new Error("IMAP host is not allowed");
	const addresses = isIP(host)
		? [{ address: host, family: isIP(host) }]
		: await network.resolve(host);
	if (
		!addresses.length ||
		addresses.some((row) => !isPublicImapAddress(row.address))
	)
		throw new Error("Private IMAP hosts are not allowed");
	let failure: unknown;
	for (const address of addresses) {
		if (signal?.aborted) throw new Error("IMAP operation cancelled");
		try {
			return await network.dial({
				...address,
				host,
				port: input.port,
				secure: input.secure,
				signal,
			});
		} catch (error) {
			failure = error;
		}
	}
	throw failure instanceof Error
		? failure
		: new Error("Unable to connect to IMAP server");
}
