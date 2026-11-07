import { z } from "zod";

export const HOST_VERSION = 1;
export const HOST_LIMITS = Object.freeze({
	requestBytes: 16 * 1024 * 1024,
	responseBytes: 2 * 1024 * 1024,
	sourceBytes: 1024 * 1024,
	snapshotBytes: 8 * 1024 * 1024,
	snapshotItems: 10000,
	snapshots: 32,
	snapshotTtlMs: 300000,
	planTtlMs: 1800000,
	sourceTtlMs: 86400000,
	payloadTtlMs: 86400000,
	receiptTtlMs: 30 * 86400000,
	operationsPerEpoch: 100000,
	maxPlans: 4096,
	maxSources: 10000,
	sourceHandles: 8192,
	modelInputBytes: 128 * 1024,
	modelOutputBytes: 65536,
	modelTimeoutMs: 120000,
	pageSize: 100,
	requests: 64,
	timeoutMs: 30000,
});
export class HostError extends Error {
	constructor(
		readonly code: string,
		readonly status = "blocked",
	) {
		super(code);
	}
}
export function demand(condition: unknown, code: string): asserts condition {
	if (!condition) throw new HostError(code);
}
const id = z.string().min(1).max(256);
const scopes = z
	.array(id)
	.min(1)
	.max(64)
	.refine((x) => new Set(x).size === x.length);
export const grantSchema = z
	.object({
		clientId: id,
		scopeKeys: scopes,
		read: z.boolean(),
		write: z.boolean(),
		forgetAll: z.boolean(),
		confirmedWrites: z.boolean(),
	})
	.strict();
export type Grant = z.infer<typeof grantSchema>;
export const profileSchema = z
	.object({
		version: z.literal(1),
		socketPath: id,
		credential: id,
		modelCommand: z.array(z.string().min(1)).min(1).optional(),
		modelDailyCalls: z.number().int().positive().max(10000).optional(),
	})
	.strict();
export type Profile = z.infer<typeof profileSchema>;
export const configSchema = z
	.object({
		version: z.literal(1),
		principal: id,
		scopeKeys: scopes,
		socketPath: id,
		credentials: z.record(id, grantSchema),
	})
	.strict();
export type HostConfig = z.infer<typeof configSchema>;
export const evidenceSchema = z
	.object({
		actionIndex: z.number().int().min(0).max(7),
		sourceHandle: id,
		startByte: z.number().int().min(0),
		endByte: z.number().int().positive(),
	})
	.strict();
export const methodSchemas = {
	status: z.object({}).strict(),
	source: z
		.object({
			submissionId: id,
			scopeKey: id,
			content: z.string().min(1),
			kind: z.enum(["text", "record"]).default("text"),
		})
		.strict(),
	context: z
		.object({
			scopeKeys: scopes.optional(),
			cursor: id.optional(),
			limit: z.number().int().min(1).max(100).default(100),
		})
		.strict(),
	read: z
		.object({
			snapshotId: id.optional(),
			itemId: id.optional(),
			sourceHandle: id.optional(),
		})
		.strict(),
	plan: z
		.object({
			snapshotId: id,
			scopeKey: id,
			proposal: z.unknown(),
			evidence: z.array(evidenceSchema).max(8).default([]),
			sourceHandles: z.array(id).max(8).default([]),
		})
		.strict(),
	apply: z.object({ planId: id, operationId: id, epoch: id }).strict(),
	operation: z.object({ operationId: id, epoch: id }).strict(),
} as const;
export type Method = keyof typeof methodSchemas;
export type MethodInput<M extends Method> = z.input<(typeof methodSchemas)[M]>;
export type MethodParams<M extends Method> = z.output<
	(typeof methodSchemas)[M]
>;
export type HostResult = {
	status: string;
	code?: string;
	[key: string]: unknown;
};
export function failure(error: unknown): HostResult {
	if (error instanceof HostError)
		return {
			status: [
				"SNAPSHOT_STALE",
				"PLAN_STALE",
				"SOURCE_STALE",
				"SNAPSHOT_EXPIRED",
				"ACCESS_CHANGED",
			].includes(error.code)
				? "stale"
				: error.status,
			code: error.code,
		};
	if (error instanceof z.ZodError)
		return { status: "blocked", code: "INVALID_INPUT" };
	return { status: "failed", code: "HOST_OPERATION_FAILED" };
}
export function exitCode(result: HostResult): number {
	if (
		[
			"ready",
			"registered",
			"context",
			"found",
			"planned",
			"completed",
		].includes(result.status)
	)
		return 0;
	if (result.status === "needs_clarification") return 2;
	if (["partial", "pending"].includes(result.status)) return 3;
	if (["blocked", "stale"].includes(result.status)) return 4;
	return 1;
}
