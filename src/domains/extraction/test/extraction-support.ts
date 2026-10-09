/** Extraction の永続テスト用の入力ビルダー（テスト専用）。 */
import type { SourceRole } from "../../../contracts/common.ts";
import type {
	ExtractionInput,
	PrepareExtractionInput,
	SettleExtractionInput,
} from "../contracts/index.ts";
import { DEFAULT_ADMISSION_POLICY } from "../../state/contracts/index.ts";
import type {
	AdmissionPolicy,
	ExtractionSource,
	HostSourceState,
} from "../../state/contracts/index.ts";
import type { SourceState } from "../../../contracts/types.ts";
import { prepareExtraction, settleExtraction } from "../repository/index.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { ACCESS, SCOPE, makeSource } from "../../state/testing.ts";
import type { TestStore } from "../../../../test/support/store.ts";

export { ACCESS, SCOPE, makeSource };

export const AUTO: AdmissionPolicy = {
	preference: "auto_admit",
	personal_fact: "auto_admit",
	constraint: "auto_admit",
	habit: "auto_admit",
	other_person_note: "user_confirm",
};

export const DEFAULT_POLICY = DEFAULT_ADMISSION_POLICY;

export function extSource(
	source: HostSourceState,
	role: SourceRole = "user",
): ExtractionSource {
	return { ...source, role };
}

export function prepareInput(
	jobId: string,
	sources: readonly ExtractionSource[],
	overrides: Partial<PrepareExtractionInput> = {},
): PrepareExtractionInput {
	return {
		contractVersion: 1,
		access: ACCESS,
		scopeKey: SCOPE,
		clock: { atMs: 1000 },
		run: { jobId, attempt: 1 },
		enabled: true,
		sources,
		profile: {
			extractorId: "stub",
			promptVersion: "p1",
			providerRef: "provider-a",
		},
		maxInputBytes: 65536,
		...overrides,
	};
}

/** SourceState（本文つき）。ホストが settle 時に同 transaction で読み直したもの。 */
export function current(source: HostSourceState): SourceState {
	const { ordinal: _ordinal, ...rest } = source;
	return rest;
}

export function settleInput(
	jobId: string,
	output: unknown,
	currentSources: readonly SourceState[],
	policy: AdmissionPolicy = DEFAULT_POLICY,
	overrides: Partial<SettleExtractionInput> = {},
): SettleExtractionInput {
	return {
		contractVersion: 1,
		access: ACCESS,
		scopeKey: SCOPE,
		clock: { atMs: 2000 },
		run: { jobId, attempt: 1 },
		output,
		currentSources,
		policy,
		...overrides,
	};
}

/** `input.sources[sourceIndex]` の本文から quote の最初の出現を byte 範囲にした evidence。 */
export function evidenceOf(
	input: ExtractionInput,
	sourceIndex: number,
	quote: string,
): {
	sourceIndex: number;
	startByte: number;
	endByte: number;
	quote: string;
} {
	const content = input.sources[sourceIndex]?.content ?? "";
	const at = content.indexOf(quote);
	if (at < 0) throw new Error("quote not found");
	const startByte = Buffer.byteLength(content.slice(0, at), "utf8");
	return {
		sourceIndex,
		startByte,
		endByte: startByte + Buffer.byteLength(quote, "utf8"),
		quote,
	};
}

export function candidateOf(
	input: ExtractionInput,
	quote: string,
	overrides: Record<string, unknown> = {},
	sourceIndex = 0,
): Record<string, unknown> {
	return {
		kind: "preference",
		subject: "self",
		semanticKey: "drink",
		value: { text: "コーヒー", polarity: "affirmed" },
		modality: "asserted",
		temporal: "current",
		evidence: [evidenceOf(input, sourceIndex, quote)],
		...overrides,
	};
}

export function readyInput(
	store: TestStore,
	jobId: string,
	sources: readonly ExtractionSource[],
	overrides: Partial<PrepareExtractionInput> = {},
): ExtractionInput {
	const result = store.write((db: MemoryDb) =>
		prepareExtraction(db, prepareInput(jobId, sources, overrides)),
	);
	if (result.status !== "ready") {
		throw new Error(`prepare not ready: ${JSON.stringify(result)}`);
	}
	return result.input;
}

export function settle(
	store: TestStore,
	input: SettleExtractionInput,
): ReturnType<typeof settleExtraction> {
	return store.write((db: MemoryDb) => settleExtraction(db, input));
}

export function count(store: TestStore, sql: string): number {
	return (store.writer.query(sql).get() as { n: number }).n;
}
