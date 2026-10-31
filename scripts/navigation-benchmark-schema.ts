import { z } from "zod";

const navigation = {
	id: z.number().int().positive(),
	path: z.enum(["/inbox", "/sent"]),
};
export const navigationEventSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("start"), ...navigation }),
	z.object({
		kind: z.literal("done"),
		...navigation,
		elapsedMs: z.number().nonnegative(),
	}),
]);
export const requestMetricSchema = z.object({
	nav: z.number().int().nonnegative(),
	path: z.string(),
	method: z.string(),
	status: z.number(),
	headersMs: z.number(),
	bytes: z.number().nonnegative(),
});
export const navigationMetricsSchema = z.object({
	events: z.array(navigationEventSchema.and(z.object({ time: z.number() }))),
	requests: z.array(requestMetricSchema),
});
export const navigationBenchmarkMetadataSchema = z.object({
	createdAt: z.string(),
	messages: z.literal(10101),
	delayMs: z.number(),
	platform: z.string(),
	bun: z.string(),
	referenceVersion: z.string(),
	beforeSha256: z.string(),
	afterSha256: z.string(),
});
export type NavigationMetrics = z.output<typeof navigationMetricsSchema>;
