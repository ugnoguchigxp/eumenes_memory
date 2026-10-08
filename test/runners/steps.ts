/**
 * Records / Recall の fixture 実行器（step 形式）。fixture は言語非依存 JSON で、`steps` を順に実行し、各 step の
 * `expect` を検証する。期待値（digest・byte offset・hash）は fixture 側が持ち、ここでは計算しない。
 * 実装は引数で受け取る（`src` を直接 import しない）。
 */
import { createHash } from "node:crypto";
import { expect } from "bun:test";
import type { AccessContext } from "eumenes-memory";
import type {
	ForgetJournalEntry,
	MemoryDb,
	RecallStrategy,
	SearchRecordsInput,
	SearchRecordsResult,
} from "eumenes-memory/sqlite";
import {
	captureRecord,
	deactivateRecord,
	reactivateRecord,
	readRecord,
	readRecordRange,
	searchRecords,
} from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";
import { forgetRecord } from "./records-support.ts";

type Obj = Record<string, unknown>;

export interface StepsApi {
	/** 純粋な範囲読み出し（DB 経由の結果と一致することを照合する）。 */
	readonly sliceUtf8Range: (
		content: string,
		range: { startByte: number; endByte: number },
	) => unknown;
	/** 戦略を指定した検索（内部関数）。 */
	readonly searchWithStrategy: (
		db: MemoryDb,
		input: SearchRecordsInput,
		strategy: RecallStrategy | undefined,
	) => SearchRecordsResult;
}

/** 型を緩めた toEqual（期待値は JSON 由来で型が狭くならない）。 */
function eq(received: unknown, expected: unknown): void {
	expect(received).toEqual(expected);
}

const DEFAULT_SCOPE = "scope:a";
const OWNER = "local:owner";
const ALL_SCOPES = ["scope:a", "scope:b", "scope:c"];

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function access(
	scopes: readonly string[] = ALL_SCOPES,
	principal: string = OWNER,
): AccessContext {
	return {
		principal,
		scopeKeys: scopes,
		purpose: "fixture",
		policyRevision: "1",
	};
}

function textOf(step: Obj): string {
	if (typeof step["content"] === "string") return step["content"];
	const repeat = step["contentRepeat"] as { unit: string; times: number };
	return repeat.unit.repeat(repeat.times);
}

function codePoints(text: string): number {
	return [...text].length;
}

interface Known {
	readonly recordId: string;
	readonly scope: string;
	readonly origin: string;
	/** 最後に capture した revision（step が revision を省略したときの既定）。 */
	readonly revision?: string;
}

export function runSteps(fixture: Obj, api: StepsApi): void {
	const store: TestStore = openTestStore();
	try {
		execute(store, fixture, api);
	} finally {
		store.close();
	}
}

function execute(store: TestStore, fixture: Obj, api: StepsApi): void {
	const byKey = new Map<string, Known>();
	const byId = new Map<string, Known>();
	const labels = new Map<string, string>();
	const contents = new Map<string, string>();
	const key = (scope: string, origin: string) => `${scope}|${origin}`;
	const journal: ForgetJournalEntry[] = [];

	const ref = (step: Obj): Known => {
		const scope = (step["scope"] as string | undefined) ?? DEFAULT_SCOPE;
		const origin = step["origin"] as string;
		const known = byKey.get(key(scope, origin));
		if (known === undefined) {
			// capture していない origin への読み出しは missing を確かめるために許す
			return { recordId: `rec:${"0".repeat(64)}`, scope, origin };
		}
		return known;
	};
	const revisionOf = (step: Obj): string | undefined => {
		const value = step["revision"] as string | undefined;
		if (value === undefined) return undefined;
		return value.startsWith("@") ? labels.get(value.slice(1)) : value;
	};
	const stepAccess = (step: Obj): AccessContext =>
		access(
			(step["accessScopes"] as string[] | undefined) ?? ALL_SCOPES,
			(step["principal"] as string | undefined) ?? OWNER,
		);
	const labelOf = (recordId: string): string => {
		const known = byId.get(recordId);
		if (known === undefined) return `?${recordId}`;
		return `${known.origin}@${known.scope}`;
	};
	const matchesLabel = (actual: string, expected: string): boolean =>
		actual === expected ||
		(!expected.includes("@") && actual === `${expected}@${DEFAULT_SCOPE}`);

	for (const [index, raw] of (fixture["steps"] as Obj[]).entries()) {
		const step = raw;
		const where = `${String(fixture["id"])} step ${index} (${String(step["op"])})`;
		const expectation = (step["expect"] ?? {}) as Obj;
		switch (step["op"]) {
			case "capture": {
				const scope = (step["scope"] as string | undefined) ?? DEFAULT_SCOPE;
				const origin = step["origin"] as string;
				const content = textOf(step);
				const result = store.write((db) =>
					captureRecord(db, {
						contractVersion: 1,
						access: access(),
						scopeKey: scope,
						clock: { atMs: 1 },
						origin: { namespace: "web", kind: "page", id: origin },
						mediaType:
							(step["mediaType"] as "text/plain" | undefined) ?? "text/plain",
						content,
						captureState: "complete",
					}),
				);
				if (expectation["blocked"] !== undefined) {
					eq(
						{ where, ...result },
						{
							where,
							status: "blocked",
							reasonCode: expectation["blocked"] as never,
						},
					);
					break;
				}
				if (result.status !== "captured") throw new Error(`${where}: blocked`);
				eq(
					{
						where,
						revision: result.revision,
						digest: result.digest,
					},
					{
						where,
						revision: `sha256:${sha256(content)}`,
						digest: sha256(content),
					},
				);
				if (expectation["created"] !== undefined) {
					eq(
						{ where, created: result.created },
						{
							where,
							created: expectation["created"] as boolean,
						},
					);
				}
				const known = {
					recordId: result.recordId,
					scope,
					origin,
					revision: result.revision,
				};
				byKey.set(key(scope, origin), known);
				byId.set(result.recordId, known);
				contents.set(`${result.recordId}|${result.revision}`, content);
				if (typeof step["label"] === "string") {
					labels.set(step["label"], result.revision);
				}
				break;
			}
			case "bulk": {
				const scope = step["scope"] as string;
				const count = step["count"] as number;
				const template = step["template"] as string;
				store.write((db) => {
					for (let n = 0; n < count; n += 1) {
						const result = captureRecord(db, {
							contractVersion: 1,
							access: access(),
							scopeKey: scope,
							clock: { atMs: 1 },
							origin: { namespace: "bulk", kind: "row", id: String(n) },
							mediaType: "text/plain",
							content: template.replace("{n}", String(n)),
							captureState: "complete",
						});
						if (result.status !== "captured")
							throw new Error(`${where}: blocked`);
					}
				});
				break;
			}
			case "read": {
				const known = ref(step);
				const revision = revisionOf(step);
				const result = store.read((db) =>
					readRecord(db, {
						contractVersion: 1,
						access: stepAccess(step),
						scopeKey: known.scope,
						recordId: known.recordId,
						...(revision === undefined ? {} : { revision }),
					}),
				);
				eq(
					{ where, status: result.status },
					{
						where,
						status: expectation["status"] as string,
					},
				);
				if (result.status === "available") {
					if (expectation["content"] !== undefined) {
						eq(
							{ where, content: result.content },
							{
								where,
								content: expectation["content"] as string,
							},
						);
					}
					if (expectation["recordStatus"] !== undefined) {
						eq(
							{ where, status: result.record.status },
							{
								where,
								status: expectation["recordStatus"] as string,
							},
						);
					}
				}
				break;
			}
			case "range": {
				const known = ref(step);
				const revision = revisionOf(step) ?? known.revision;
				if (revision === undefined)
					throw new Error(`${where}: revision required`);
				const range = {
					startByte: step["start"] as number,
					endByte: step["end"] as number,
				};
				const result = store.read((db) =>
					readRecordRange(db, {
						contractVersion: 1,
						access: stepAccess(step),
						scopeKey: known.scope,
						recordId: known.recordId,
						revision,
						range,
					}),
				) as Obj;
				const actual: Obj = { ...result };
				const wanted: Obj = { ...expectation };
				if (wanted["textLength"] !== undefined) {
					eq(
						{ where, length: (actual["text"] as string).length },
						{
							where,
							length: wanted["textLength"] as number,
						},
					);
					delete wanted["textLength"];
					delete actual["text"];
				}
				eq({ where, ...actual }, { where, ...wanted });
				// 純粋関数の結果が DB 経由の結果と一致する
				const content = contents.get(`${known.recordId}|${revision}`);
				if (
					content !== undefined &&
					(result["status"] === "available" ||
						result["status"] === "invalid_range")
				) {
					const pure = api.sliceUtf8Range(content, range) as Obj;
					if (pure["status"] === "ok") {
						eq(
							{
								where,
								text: pure["text"],
								digest: pure["digest"],
							},
							{
								where,
								text: result["text"],
								digest: result["digest"],
							},
						);
					} else {
						eq(
							{ where, ...pure },
							{
								where,
								status: result["status"],
								reasonCode: result["reasonCode"],
							},
						);
					}
				}
				break;
			}
			case "deactivate":
			case "reactivate": {
				const known = ref(step);
				const input = {
					contractVersion: 1,
					access: access(),
					scopeKey: known.scope,
					clock: { atMs: 2 },
					recordId: known.recordId,
				} as const;
				const result = store.write((db) =>
					step["op"] === "deactivate"
						? deactivateRecord(db, input)
						: reactivateRecord(db, input),
				);
				if (expectation["status"] !== undefined) {
					eq(
						{ where, status: result.status },
						{
							where,
							status: expectation["status"] as string,
						},
					);
				}
				break;
			}
			case "forget": {
				const known = ref(step);
				const { entry } = forgetRecord(
					store,
					{ type: "record", recordId: known.recordId, scopeKey: known.scope },
					3,
				);
				journal.push(entry);
				break;
			}
			case "ftsCount": {
				const term = (step["term"] as string).replace(/[A-Z]/g, (c) =>
					c.toLowerCase(),
				);
				const row = store.writer
					.query(
						"SELECT COUNT(*) AS n FROM memory_record_fts WHERE memory_record_fts MATCH ?",
					)
					.get(`"${term}"`) as { n: number };
				eq(
					{ where, n: row.n },
					{
						where,
						n: step["expect"] as number,
					},
				);
				break;
			}
			case "search": {
				runSearch(
					store,
					step,
					access,
					api,
					labelOf,
					matchesLabel,
					where,
					contents,
					byId,
				);
				break;
			}
			default:
				throw new Error(`${where}: unknown op`);
		}
	}
}

function runSearch(
	store: TestStore,
	step: Obj,
	access: (scopes?: readonly string[], principal?: string) => AccessContext,
	api: StepsApi,
	labelOf: (recordId: string) => string,
	matchesLabel: (actual: string, expected: string) => boolean,
	where: string,
	_contents: Map<string, string>,
	_byId: Map<string, Known>,
): void {
	const expectation = step["expect"] as Obj;
	const scopes = step["scopes"] as string[];
	const query = step["query"] as string;
	const principal = (step["principal"] as string | undefined) ?? OWNER;
	const limit = (step["limit"] as number | undefined) ?? 50;
	const input = (cursor?: string): SearchRecordsInput => ({
		contractVersion: 1,
		access: access(ALL_SCOPES, principal),
		scopeKeys: scopes,
		query,
		limit,
		...(cursor === undefined ? {} : { cursor }),
	});
	const search = (strategy: RecallStrategy | undefined, cursor?: string) =>
		store.read((db) => api.searchWithStrategy(db, input(cursor), strategy));

	if (expectation["status"] === "blocked") {
		eq(
			{ where, result: search(undefined) },
			{
				where,
				result: {
					status: "blocked",
					reasonCode: expectation["reasonCode"] as never,
				},
			},
		);
		return;
	}
	// 公開 API（searchRecords）と内部の既定戦略が同じ結果を返す
	const viaPublic = store.read((db) => searchRecords(db, input()));
	const natural = search(undefined);
	eq({ where, result: viaPublic }, { where, result: natural });
	if (natural.status !== "ok") throw new Error(`${where}: expected ok`);
	if (expectation["natural"] !== undefined) {
		eq(
			{ where, strategy: natural.strategy },
			{
				where,
				strategy: expectation["natural"] as string,
			},
		);
	}
	const terms = query.split(/[ 　\t\n]+/).filter((term) => term.length > 0);
	const ftsPossible = terms.every((term) => codePoints(term) >= 3);

	const strategies: (RecallStrategy | undefined)[] = ["like"];
	if (ftsPossible) strategies.push("fts");
	const baseline = JSON.stringify(natural.hits);
	for (const strategy of strategies) {
		const result = search(strategy);
		if (result.status !== "ok") throw new Error(`${where}: expected ok`);
		eq(
			{ where, strategy, strategyUsed: result.strategy },
			{
				where,
				strategy,
				strategyUsed: strategy as string,
			},
		);
		eq(
			{ where, strategy, hits: JSON.stringify(result.hits) },
			{
				where,
				strategy,
				hits: baseline,
			},
		);
	}

	if (expectation["pages"] !== undefined) {
		const pages: string[][] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 100; guard += 1) {
			const page = search(undefined, cursor);
			if (page.status !== "ok") throw new Error(`${where}: expected ok`);
			pages.push(
				page.hits.map((hit) => labelOf(hit.ref.id).split("@")[0] as string),
			);
			cursor = page.nextCursor;
			if (cursor === undefined) break;
		}
		eq(
			{ where, pages },
			{
				where,
				pages: expectation["pages"] as string[][],
			},
		);
		return;
	}
	const labels = natural.hits.map((hit) => labelOf(hit.ref.id));
	const wanted = expectation["origins"] as string[];
	eq(
		{ where, count: labels.length },
		{
			where,
			count: wanted.length,
		},
	);
	for (const [position, label] of labels.entries()) {
		eq(
			{
				where,
				position,
				label,
				ok: matchesLabel(label, wanted[position] as string),
			},
			{ where, position, label, ok: true },
		);
	}
	for (const hit of natural.hits) {
		expect(hit.authority).toBe("evidence_candidate");
		expect(hit.ref.namespace).toBe("memory");
		expect(hit.ref.kind).toBe("record");
	}
	const ranges = (expectation["ranges"] ?? {}) as Record<string, number[]>;
	for (const hit of natural.hits) {
		const origin = labelOf(hit.ref.id).split("@")[0] as string;
		const wantedRange = ranges[origin] ?? ranges[labelOf(hit.ref.id)];
		if (wantedRange !== undefined) {
			eq(
				{ where, origin, range: hit.ref.range },
				{
					where,
					origin,
					range: {
						startByte: wantedRange[0] as number,
						endByte: wantedRange[1] as number,
					},
				},
			);
		}
		const include = (
			(expectation["snippetIncludes"] ?? {}) as Record<string, string>
		)[origin];
		if (include !== undefined) expect(hit.snippet).toContain(include);
		if (expectation["snippetMaxBytes"] !== undefined) {
			expect(new TextEncoder().encode(hit.snippet).length).toBeLessThanOrEqual(
				expectation["snippetMaxBytes"] as number,
			);
		}
	}
}
