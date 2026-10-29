import { createHmac, timingSafeEqual } from "node:crypto";
/** Same wire signature as the Worker, without allocating prefix + MIME again. */
export function verifyInboundSignature(
	secret: string,
	timestamp: string,
	from: string,
	to: string,
	bytes: Uint8Array,
	signature: string,
	now = Date.now(),
) {
	if (
		!/^\d+$/.test(timestamp) ||
		Math.abs(now - Number(timestamp)) > 5 * 60_000 ||
		!/^[a-f0-9]{64}$/.test(signature)
	)
		return false;
	const expected = createHmac("sha256", secret)
		.update(`${timestamp}\n${from}\n${to}\n`)
		.update(bytes)
		.digest();
	return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
