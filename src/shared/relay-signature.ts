export async function signRelay(secret: string, timestamp: string, from: string, to: string, bytes: Uint8Array<ArrayBuffer>) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`${timestamp}\n${from}\n${to}\n`);
	const signed = new Uint8Array(prefix.length + bytes.length);
	signed.set(prefix);
	signed.set(bytes, prefix.length);
	return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function verifyRelay(secret: string, timestamp: string, from: string, to: string, bytes: Uint8Array<ArrayBuffer>, signature: string, now = Date.now()) {
	if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 5 * 60_000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
	const expected = await signRelay(secret, timestamp, from, to, bytes);
	let difference = 0;
	for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	return difference === 0;
}
