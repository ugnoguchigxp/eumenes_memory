/**
 * Records の fixture 実行器（step 形式）。fixture は言語非依存 JSON で、`steps` を順に実行し、各 step の
 * `expect` を検証する。期待値（digest・byte offset・hash）は fixture 側が持ち、ここでは計算しない。
 * 実装は引数で受け取る（`src` を直接 import しない）。
 */
import { createHash } from "node:crypto";
import { expect } from "bun:test";
import type { AccessContext } from "eumenes-memory";
import type { ForgetJournalEntry } from "eumenes-memory/sqlite";
import { captureRecord, readRecord } from "eumenes-memory/sqlite";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";
import { forgetRecord } from "./records-support.ts";

type Obj = Record<string, unknown>;

export interface StepsApi {
	/** 純粋な範囲読み出し。保存した本文（`readRecord`）に適用して、fixture の期待と照合する。 */
	readonly sliceUtf8Range: (
		content: string,
		range: { startByte: number; endByte: number },
	) => unknown;
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
	const labels = new Map<string, string>();
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
				if (typeof step["label"] === "string") {
					labels.set(step["label"], result.revision);
				}
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
				const read = store.read((db) =>
					readRecord(db, {
						contractVersion: 1,
						access: stepAccess(step),
						scopeKey: known.scope,
						recordId: known.recordId,
						revision,
					}),
				);
				const actual: Obj =
					read.status !== "available"
						? { status: read.status }
						: (() => {
								const slice = api.sliceUtf8Range(read.content, range) as Obj;
								return slice["status"] === "ok"
									? {
											status: "available",
											text: slice["text"],
											digest: slice["digest"],
										}
									: slice;
							})();
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
			default:
				throw new Error(`${where}: unknown op`);
		}
	}
}
