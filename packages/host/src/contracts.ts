import { z } from "zod";
import { STATE_KINDS } from "eumenes-memory";
import { directAgendaWrite } from "./agenda-contract.ts";

export const HOST_VERSION = 1;
/** 出典の由来（§4B.3）。`user_message` と `agent_reasoning` 以外は外部由来として扱う。 */
export const PROVENANCES = [
	"user_message",
	"agent_reasoning",
	"tool_result",
	"web",
	"other_agent",
	"import",
	"unknown",
] as const;
export type Provenance = (typeof PROVENANCES)[number];
export const INTERNAL_PROVENANCES: readonly Provenance[] = Object.freeze([
	"user_message",
	"agent_reasoning",
]);
/** item の信頼度（§4B.3）。順位には使わない。 */
export type Trust = "confirmed" | "inferred" | "external";
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
	/** search の件数の上限（§3.7）。設定では変えない。 */
	searchResults: 20,
	/** search が作る不完全な snapshot の枠（§4.2）。超えたら古いものから捨てる。 */
	searchSnapshots: 32,
	/** すべての語が 3 文字未満のときに走査してよい item の数（§3.7、S8 の bench で確かめた）。 */
	searchScanMax: 20000,
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
/** 核の State の subject の上限（`LIMITS_STATE.maxSubjectBytes`、UTF-8 の byte 数）。 */
const MAX_SUBJECT_BYTES = 128;
/** 核の識別子の規則（制御文字なし、lone surrogate なし）と subject の byte の上限を満たすか。 */
/** 対になっていない surrogate（UTF-8 に直せない文字）。 */
export const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function isStateSubjectText(text: string): boolean {
	if (
		LONE_SURROGATE.test(text) ||
		Buffer.byteLength(text, "utf8") > MAX_SUBJECT_BYTES
	)
		return false;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c <= 0x1f || c === 0x7f) return false;
	}
	return true;
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
		/** バックアップの置き場所（決定 10）。無ければ backup は BACKUP_NOT_CONFIGURED。 */
		backupDirectory: id.optional(),
		recovery: z
			.object({
				directory: id,
				storeId: z.string().regex(/^[0-9a-f]{32}$/),
			})
			.strict()
			.optional(),
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
export const planApplySchema = z
	.object({ planId: id, operationId: id, epoch: id })
	.strict();
export type PlanApplyParams = z.infer<typeof planApplySchema>;
export const methodSchemas = {
	status: z.object({}).strict(),
	source: z
		.object({
			submissionId: id,
			scopeKey: id,
			content: z.string().min(1),
			kind: z.enum(["text", "record", "agent_reply"]).default("text"),
			/** 出典の由来。Grok Bot の自己申告で、実行環境は確かめない（決定 12）。信頼を下げる方向にだけ効く。 */
			provenance: z.enum(PROVENANCES).default("unknown"),
		})
		.strict(),
	context: z
		.object({
			scopeKeys: scopes.optional(),
			cursor: id.optional(),
			agenda: z.boolean().optional(),
			limit: z.number().int().min(1).max(100).default(100),
		})
		.strict(),
	read: z
		.object({
			snapshotId: id.optional(),
			itemId: id.optional(),
			itemIds: z.array(id).min(1).max(HOST_LIMITS.searchResults).optional(),
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
	apply: planApplySchema
		.partial()
		.extend({ agenda: directAgendaWrite.optional() })
		.strict()
		.refine((p) =>
			p.agenda
				? !p.planId && !p.operationId && !p.epoch
				: p.planId && p.operationId && p.epoch,
		),
	operation: z.object({ operationId: id, epoch: id }).strict(),
	/** 管理用（admin の grant）。MCP には出さない（`CLI_ONLY_METHODS`）。 */
	backup: z.object({}).strict(),
	/**
	 * 回答や行動に採用した item の報告（決定 11、S6b）。外部由来の item の期限を延ばす。
	 * snapshot に入っていて revision が今のものと一致する item だけを受け付ける。
	 */
	use: z
		.object({
			snapshotId: id,
			items: z
				.array(
					z.object({ itemId: id, revision: z.number().int().min(1) }).strict(),
				)
				.min(1)
				.max(20),
		})
		.strict(),
	/**
	 * 許可された active な State の全文検索（§4.2、S9）。読み取りだけで、件数は 20 件、応答の item は maxBytes まで。
	 * query の 256 文字と 1024 B の上限は、`QUERY_INVALID` にするため無害化の側で検査する（zod は転送の上限だけ）。
	 */
	search: z
		.object({
			query: z.string().min(1).max(4096),
			scopeKeys: scopes.optional(),
			// 核の検索（`parseSearchStateInput`）と同じ規則。違反を核まで通すと、入力の誤りが failed になる。
			kinds: z
				.array(z.enum(STATE_KINDS))
				.min(1)
				.max(5)
				.refine((kinds) => new Set(kinds).size === kinds.length)
				.optional(),
			subject: z
				.union([
					z.literal("self"),
					z
						.string()
						.regex(/^other:./su)
						.refine(isStateSubjectText),
				])
				.optional(),
			limit: z.number().int().min(1).max(20).default(20),
			maxBytes: z.number().int().min(16384).max(65536).default(32768),
		})
		.strict(),
	/**
	 * 見直しの一覧（§4D.2 の 3、S10）。CLI だけ（MCP には出さない）、読み取り専用、20 件まで、cursor なし。
	 * 本文は返さず、ID と鍵と理由だけを返す。
	 */
	review: z.object({ scopeKeys: scopes.optional() }).strict(),
	/** 管理用（admin）。期限を過ぎた外部由来の item を停止する（1 回 500 件まで）。MCP には出さない。 */
	expire: z.object({}).strict(),
	/** 管理用（admin）。停止した item を active に戻し、期限を数え直す。MCP には出さない。 */
	reactivate: z.object({ itemId: id }).strict(),
} as const;
/** CLI からだけ呼べる管理用の操作。MCP の道具にしない。 */
export const CLI_ONLY_METHODS: readonly string[] = Object.freeze([
	"backup",
	"review",
	"expire",
	"reactivate",
]);
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
