/**
 * Object.prototype 汚染の回帰テスト（State / Extraction / Records / Lifecycle の主要入口）。
 *
 * parse 済みの plain object や、条件付き spread で作った内部オブジェクトは Object.prototype を継承する。
 * 省略可能キーの有無を `=== undefined` / `??` で読むと、プロトタイプに仕込まれた値を拾ってしまう。
 * 各省略可能キーを 1 つずつ Object.prototype に仕込み（敵対的だが型としては有効な値）、同じ操作列を実行して、
 * 結果（戻り値 + DB の全 memory_ 行）が汚染なしの実行と一致することを確かめる。
 * 汚染の窓は操作の実行中だけ（finally で必ず外す）。期待値の比較は窓の外。
 */
import { describe, expect, test } from "bun:test";
import { openTestStore } from "../support/store.ts";
import { LIMITS } from "../../src/contracts/constants.ts";
import { isMemoryContractError } from "../../src/contracts/errors.ts";
import { parseSettleExtractionInput } from "../../src/domains/extraction/index.ts";
import { evaluateAdmission } from "../../src/domains/state/index.ts";
import { isQuotedSpan, quoteMatches } from "../../src/domains/state/index.ts";
import { parseAssertUserStateInput } from "../../src/domains/state/index.ts";
import { applyStateTransition } from "../../src/domains/state/index.ts";
import { stateValueEquals } from "../../src/domains/state/index.ts";
import { isMemoryStoreError } from "../../src/infrastructure/sqlite/errors.ts";
import type { TestStore } from "../support/store.ts";
import type { AccessContext } from "../../src/contracts/types.ts";
import type { MemoryDb } from "../../src/infrastructure/sqlite/db.ts";
import { DEFAULT_ADMISSION_POLICY } from "../../src/domains/state/contracts/index.ts";
import {
	confirmCandidate,
	listCandidates,
	prepareExtraction,
	settleExtraction,
} from "../../src/domains/extraction/sqlite.ts";
import {
	applyForget,
	planForget,
	recordExternalDeletion,
} from "../../src/domains/lifecycle/sqlite.ts";
import {
	captureRecord,
	readRecord,
	readRecordRange,
	recordSourceStates,
} from "../../src/domains/records/sqlite.ts";
import { searchRecords } from "../../src/domains/recall/sqlite.ts";
import {
	assertUserState,
	deactivateState,
	editState,
	listState,
	reactivateState,
	readMemorySnapshotPart,
	retractState,
	writeStateForCandidate,
} from "../../src/domains/state/sqlite.ts";
import {
	ACCESS,
	COFFEE,
	SCOPE,
	TEA,
	assertInput,
	editInput,
	makeSpan,
	makeSource,
	targetInput,
	value,
} from "../../src/domains/state/testing.ts";
import {
	candidateOf,
	current,
	extSource,
	prepareInput,
	settleInput,
} from "../../src/domains/extraction/testing.ts";

/**
 * 仕込む省略可能キーと敵対的な値。型として有効で、読まれれば結果が変わる値にする。
 * （新しい省略可能キーを契約に足したら、ここにも足す。）
 */
const HOSTILE: Readonly<Record<string, unknown>> = Object.freeze({
	// State
	attributes: { evil: "1" },
	validFromMs: 123,
	validUntilMs: 456789,
	replaces: { itemId: "state:nonexistent", revision: 1 },
	kinds: ["habit"],
	includeInactive: true,
	limit: 1,
	value: { text: "evil", polarity: "negated" },
	origin: "admitted_extraction",
	evidenceOrdinal: 99999,
	identity: { itemId: "state:evil", subject: "self", kind: "habit" },
	// SourceRef / SourceState
	range: { startByte: 0, endByte: 1 },
	representation: "evil",
	content: "evil",
	// Extraction
	decision: "rejected",
	editedValue: { text: "evil", polarity: "negated" },
	keyHistory: { disputedMaxOrdinal: 99999, userRemoved: true },
	// Records / Recall / Lifecycle
	revision: "evil",
	runRef: { jobId: "evil", attempt: 1 },
	providerRef: "evil",
	withContent: true,
	cursor: "evil",
	externalId: "evil",
	// 判別用の内部結果（`"reasonCode" in x` ではなく own で判定する）
	reasonCode: "SOURCE_STALE",
	// View v2
	subject: "other:evil",
	evidence: [],
});

/** key を Object.prototype に仕込んで fn を実行し、必ず外す。 */
function withPrototype<T>(key: string, hostile: unknown, fn: () => T): T {
	if (Object.hasOwn(Object.prototype, key)) {
		throw new Error(`Object.prototype already has ${key}`);
	}
	Object.defineProperty(Object.prototype, key, {
		value: hostile,
		writable: true,
		configurable: true,
		enumerable: true,
	});
	try {
		return fn();
	} finally {
		delete (Object.prototype as unknown as Record<string, unknown>)[key];
	}
}

function dump(store: TestStore): string {
	const tables = store.writer
		.query(
			`SELECT name FROM sqlite_master
			WHERE type = 'table' AND name LIKE 'memory\\_%' ESCAPE '\\'
				AND name NOT LIKE 'memory\\_record\\_fts%' ESCAPE '\\'
			ORDER BY name`,
		)
		.all() as { name: string }[];
	const out: Record<string, unknown[]> = {};
	for (const { name } of tables) {
		out[name] = store.writer.query(`SELECT * FROM ${name} ORDER BY 1, 2`).all();
	}
	return JSON.stringify(out);
}

/** 操作列を実行し、戻り値と DB 全体を 1 つの文字列にする。汚染の有無にかかわらず同じになるべき値。 */
type Flow = (
	store: TestStore,
	log: (label: string, result: unknown) => void,
) => void;

function runFlow(flow: Flow): string {
	const store = openTestStore();
	try {
		const entries: string[] = [];
		const log = (label: string, result: unknown) => {
			entries.push(`${label}=${JSON.stringify(result)}`);
		};
		flow(store, log);
		entries.push(`db=${dump(store)}`);
		return entries.join("\n");
	} finally {
		store.close();
	}
}

function expectInvariant(flow: Flow): void {
	const clean = runFlow(flow);
	expect(clean.length).toBeGreaterThan(100);
	for (const [key, hostile] of Object.entries(HOSTILE)) {
		const polluted = withPrototype(key, hostile, () => runFlow(flow));
		if (polluted !== clean) {
			throw new Error(`result changed when Object.prototype.${key} is set`);
		}
	}
}

// ---- State ----

const stateFlow: Flow = (store, log) => {
	const w = <T>(fn: (db: MemoryDb) => T): T => store.write(fn);
	// attributes なしの値・replaces なし・期限なし（省略可能キーがすべて「無い」呼び出し）
	const a = w((db) => assertUserState(db, assertInput()));
	log("assert", a);
	const itemId = a.status === "applied" ? a.item.itemId : "state:none";
	log(
		"assert-different-no-replaces",
		w((db) =>
			assertUserState(
				db,
				assertInput({
					value: value("紅茶が好き"),
					evidence: [makeSpan(TEA, "紅茶が好き")],
					sources: [TEA],
				}),
			),
		),
	);
	log(
		"assert-same",
		w((db) => assertUserState(db, assertInput())),
	);
	log(
		"list-default",
		store.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		),
	);
	log(
		"edit",
		w((db) =>
			editState(
				db,
				editInput(itemId, 1, {
					value: value("緑茶が好き"),
					evidence: [makeSpan(TEA, "紅茶が好き")],
					sources: [TEA],
				}),
			),
		),
	);
	log(
		"deactivate",
		w((db) => deactivateState(db, targetInput(itemId, 2))),
	);
	log(
		"list-after-deactivate",
		store.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		),
	);
	log(
		"reactivate",
		w((db) => reactivateState(db, targetInput(itemId, 3))),
	);
	// replaces あり（CAS）。attributes つきの値は明示された場合だけ保存される
	log(
		"supersede",
		w((db) =>
			assertUserState(
				db,
				assertInput({
					value: value("麦茶が好き", "affirmed", { strength: "high" }),
					evidence: [makeSpan(TEA, "紅茶が好き")],
					sources: [TEA],
					replaces: { itemId, revision: 4 },
					validFromMs: 10,
					validUntilMs: 20,
				}),
			),
		),
	);
	log(
		"list-all",
		store.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: true,
			}),
		),
	);
	log(
		"list-kinds",
		store.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				kinds: ["preference"],
			}),
		),
	);
	// representation を持たない出典（省略可能キーが「無い」SourceRef）
	const { representation: _representation, ...bareSource } = COFFEE;
	log(
		"assert-bare-source",
		w((db) =>
			assertUserState(
				db,
				assertInput({
					kind: "personal_fact",
					semanticKey: "likes",
					value: value("コーヒー"),
					evidence: [makeSpan(bareSource, "コーヒーが好き")],
					sources: [bareSource],
				}),
			),
		),
	);
	log(
		"snapshot-part",
		store.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		),
	);
	log(
		"retract",
		w((db) => retractState(db, targetInput(itemId, 5))),
	);
};

// ---- Extraction ----

const extractionFlow: Flow = (store, log) => {
	const source = makeSource("m9", "私はコーヒーが好き。夜は紅茶が好き。", 5);
	const prepared = store.write((db) =>
		prepareExtraction(db, prepareInput("pj1", [extSource(source)])),
	);
	log("prepare", prepared);
	if (prepared.status !== "ready") return;
	const input = prepared.input;
	const output = {
		noChange: false,
		candidates: [
			candidateOf(input, "コーヒーが好き"),
			candidateOf(input, "紅茶が好き", {
				semanticKey: "evening-drink",
				value: { text: "紅茶", polarity: "affirmed" },
			}),
			candidateOf(input, "夜は紅茶が好き", { modality: "hypothetical" }),
		],
	};
	log(
		"settle",
		store.write((db) =>
			settleExtraction(
				db,
				settleInput("pj1", output, [current(source)], {
					...DEFAULT_ADMISSION_POLICY,
					preference: "auto_admit",
				}),
			),
		),
	);
	const pendingList = store.read((db) =>
		listCandidates(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
	);
	log("candidates-default", pendingList);
	log(
		"candidates-rejected",
		store.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				decision: "rejected",
			}),
		),
	);
	// pending を作る（user_confirm の kind）。representation を持たない出典、2 件の候補
	const { representation: _representation, ...second } = makeSource(
		"m10",
		"私は猫が好き。犬も好き。",
		6,
	);
	const prepared2 = store.write((db) =>
		prepareExtraction(db, prepareInput("pj2", [extSource(second)])),
	);
	log("prepare-bare-source", prepared2);
	if (prepared2.status !== "ready") return;
	log(
		"settle-pending",
		store.write((db) =>
			settleExtraction(
				db,
				settleInput(
					"pj2",
					{
						noChange: false,
						candidates: [
							candidateOf(prepared2.input, "猫が好き", {
								semanticKey: "pet",
								value: { text: "猫", polarity: "affirmed" },
							}),
							candidateOf(prepared2.input, "犬も好き", {
								semanticKey: "pet2",
								value: { text: "犬", polarity: "affirmed" },
							}),
						],
					},
					[current(second)],
				),
			),
		),
	);
	// 本文を持たない現在状態（SourceState.content なし）: quote を検証できないので候補単位で却下される
	const third = makeSource("m11", "私は海が好き。", 7);
	const prepared3 = store.write((db) =>
		prepareExtraction(db, prepareInput("pj3", [extSource(third)])),
	);
	if (prepared3.status === "ready") {
		const { content: _content, ...withoutContent } = current(third);
		log(
			"settle-no-content",
			store.write((db) =>
				settleExtraction(
					db,
					settleInput(
						"pj3",
						{
							noChange: false,
							candidates: [candidateOf(prepared3.input, "海が好き")],
						},
						[withoutContent],
					),
				),
			),
		);
	}
	const pending = store.read((db) =>
		listCandidates(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
	);
	const first = pending.status === "ok" ? pending.candidates[0] : undefined;
	log("pending", pending);
	if (first === undefined) return;
	log(
		"confirm",
		store.write((db) =>
			confirmCandidate(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 3000 },
				candidateId: first.candidateId,
				action: "admit",
				currentSources: [current(second)],
			}),
		),
	);
};

// ---- Records / Lifecycle ----

const RECORD_ACCESS: AccessContext = {
	principal: "local:owner",
	scopeKeys: ["scope:a", "scope:b"],
	purpose: "test",
	policyRevision: "1",
};

const recordsFlow: Flow = (store, log) => {
	const cap = (id: string, content: string, providerRef?: string) =>
		store.write((db) =>
			captureRecord(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				scopeKey: "scope:a",
				clock: { atMs: 1 },
				origin: { namespace: "web", kind: "page", id },
				mediaType: "text/plain",
				content,
				captureState: "complete",
				...(providerRef === undefined ? {} : { providerRef }),
			}),
		);
	const one = cap("p1", "pollution probe body text", "provider-x");
	log("capture", one);
	if (one.status !== "captured") return;
	const two = cap("p2", "another body for the second record");
	log("capture-2", two);
	log(
		"read",
		store.read((db) =>
			readRecord(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				scopeKey: "scope:a",
				recordId: one.recordId,
			}),
		),
	);
	log(
		"range",
		store.read((db) =>
			readRecordRange(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				scopeKey: "scope:a",
				recordId: one.recordId,
				revision: one.revision,
				range: { startByte: 0, endByte: 9 },
			}),
		),
	);
	log(
		"source-states",
		store.read((db) =>
			recordSourceStates(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				scopeKey: "scope:a",
				refs: [one.ref],
			}),
		),
	);
	log(
		"search",
		store.read((db) =>
			searchRecords(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				scopeKeys: ["scope:a"],
				query: "body",
				limit: 1,
			}),
		),
	);
	// Lifecycle: record の forget → 外部 provider の pending → externalId 省略の確認記録
	const planned = store.read((db) =>
		planForget(db, {
			contractVersion: 1,
			access: RECORD_ACCESS,
			target: { type: "record", recordId: one.recordId, scopeKey: "scope:a" },
			clock: { atMs: 5 },
		}),
	);
	log("plan", planned);
	if (planned.status !== "planned") return;
	const receipt = store.write((db) =>
		applyForget(db, {
			contractVersion: 1,
			entry: planned.plan.entry,
			clock: { atMs: 6 },
		}),
	);
	log("apply", receipt);
	log(
		"external",
		store.write((db) =>
			recordExternalDeletion(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				clock: { atMs: 7 },
				forgetId: receipt.forgetId,
				providerRef: "provider-x",
				state: "confirmed",
			}),
		),
	);
	const { representation: _representation, ...bareRef } = one.ref;
	log(
		"source-states-bare-ref",
		store.read((db) =>
			recordSourceStates(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				scopeKey: "scope:a",
				refs: [bareRef],
			}),
		),
	);
	log(
		"read-forgotten",
		store.read((db) =>
			readRecord(db, {
				contractVersion: 1,
				access: RECORD_ACCESS,
				scopeKey: "scope:a",
				recordId: one.recordId,
			}),
		),
	);
};

/** 汚染なし／ありで fn の結果（JSON）が一致することを、キーごとの値を指定して確かめる。 */
function expectSameUnder(key: string, hostile: unknown, fn: () => unknown) {
	const clean = JSON.stringify(fn());
	const polluted = withPrototype(key, hostile, () => JSON.stringify(fn()));
	expect(polluted).toBe(clean);
	return clean;
}

describe("Object.prototype pollution: sites that need a targeted hostile value", () => {
	test("stateValueEquals: attributes are read from own properties only", () => {
		const left = value("x", "affirmed", { evil: "1" });
		const right = value("x");
		expect(
			expectSameUnder("attributes", { evil: "1" }, () =>
				stateValueEquals(left, right),
			),
		).toBe("false");
		expect(
			expectSameUnder("attributes", { evil: "1" }, () =>
				stateValueEquals(right, left),
			),
		).toBe("false");
	});

	test("quoteMatches / isQuotedSpan: a span without own range never matches or opens a quote", () => {
		const content = "私はコーヒーが好き";
		const noRange = {
			source: {
				namespace: "conversation",
				kind: "message",
				id: "m",
				revision: "r",
				digest: "d",
			},
			quote: "コーヒー",
		};
		const range = { startByte: 6, endByte: 18 };
		expect(
			expectSameUnder("range", range, () => quoteMatches(content, noRange)),
		).toBe("false");
		expect(
			expectSameUnder("range", { startByte: 100, endByte: 120 }, () =>
				isQuotedSpan(`「${content}`, { ...noRange, quote: "x" }),
			),
		).toBe("false");
	});

	test("applyStateTransition: transitions without value / origin / identity / ordinal are not completed from the prototype", () => {
		const view = {
			itemId: "state:a",
			subject: "self" as const,
			kind: "preference" as const,
			semanticKey: "drink",
			status: "active" as const,
			revision: 1,
			value: value("x"),
			origin: "user_confirmed" as const,
			evidenceOrdinal: 1,
		};
		const cause = { type: "user" as const, id: "u" };
		const context = { atMs: 1, activeForKey: null };
		const edit = { action: "edit" as const, expectedRevision: 1, cause };
		const assertion = {
			action: "assert" as const,
			expectedRevision: null,
			cause,
		};
		expect(
			expectSameUnder("value", { text: "evil", polarity: "affirmed" }, () =>
				applyStateTransition(view, edit, context),
			),
		).toContain("INVALID_TRANSITION");
		expect(
			expectSameUnder("origin", "admitted_extraction", () =>
				applyStateTransition(view, { ...edit, value: value("y") }, context),
			),
		).toContain("user_edited");
		expect(
			expectSameUnder("evidenceOrdinal", 99999, () =>
				applyStateTransition(view, { ...edit, value: value("y") }, context),
			),
		).toContain('"evidenceOrdinal":1');
		// 1 つだけ欠けた assert: 欠けたキーをプロトタイプから補われても INVALID_TRANSITION のまま
		const full = {
			identity: {
				itemId: "state:n",
				subject: "self" as const,
				kind: "preference" as const,
				semanticKey: "drink",
			},
			value: value("z"),
			origin: "admitted_extraction" as const,
			evidenceOrdinal: 3,
		};
		for (const key of Object.keys(full) as (keyof typeof full)[]) {
			const { [key]: hostile, ...rest } = full;
			expect(
				expectSameUnder(key, hostile, () =>
					applyStateTransition(null, { ...assertion, ...rest }, context),
				),
			).toContain("INVALID_TRANSITION");
		}
		// context.keyHistory は own のものだけ
		const ext = {
			action: "assert" as const,
			expectedRevision: null,
			identity: {
				itemId: "state:n",
				subject: "self" as const,
				kind: "preference" as const,
				semanticKey: "drink",
			},
			value: value("z"),
			origin: "admitted_extraction" as const,
			evidenceOrdinal: 3,
			cause,
		};
		expect(
			expectSameUnder(
				"keyHistory",
				{ disputedMaxOrdinal: 99, userRemoved: true },
				() => applyStateTransition(null, ext, context),
			),
		).toContain('"status":"active"');
	});

	test("evaluateAdmission: keyHistory is read from own properties only", () => {
		const source = makeSource("m", "私はコーヒーが好き", 5);
		const span = makeSpan(source, "コーヒーが好き");
		const decide = () =>
			evaluateAdmission({
				candidate: {
					kind: "preference",
					subject: "self",
					semanticKey: "drink",
					value: { text: "コーヒー", polarity: "affirmed" },
					modality: "asserted",
					temporal: "current",
					evidence: [span],
				},
				principal: ACCESS.principal,
				scopeKey: SCOPE,
				inputSources: [{ ...source, role: "user" }],
				currentSources: [source],
				activeForKey: null,
				policy: { ...DEFAULT_ADMISSION_POLICY, preference: "auto_admit" },
			});
		expect(
			expectSameUnder(
				"keyHistory",
				{ disputedMaxOrdinal: 99, userRemoved: true },
				decide,
			),
		).toBe('{"decision":"admitted"}');
	});

	test("input parse: an evidence span without own range is MISSING_KEY, a settle currentSource without content does not count toward the total", () => {
		const bare = {
			...assertInput(),
			evidence: [
				{
					source: {
						namespace: "conversation",
						kind: "message",
						id: "m1",
						revision: COFFEE.revision,
						digest: COFFEE.digest,
					},
					quote: "コーヒーが好き",
				},
			],
		};
		const codeOf = () => {
			try {
				parseAssertUserStateInput(bare);
				return "no error";
			} catch (error) {
				return isMemoryContractError(error) ? error.code : String(error);
			}
		};
		expect(expectSameUnder("range", { startByte: 0, endByte: 3 }, codeOf)).toBe(
			'"MISSING_KEY"',
		);
		const settle = settleInput("pj", { noChange: true, candidates: [] }, [
			(() => {
				const { content: _content, ...rest } = current(makeSource("m", "x", 1));
				return rest;
			})(),
		]);
		const parse = () => {
			try {
				parseSettleExtractionInput(settle);
				return "ok";
			} catch (error) {
				return isMemoryContractError(error) ? error.code : String(error);
			}
		};
		expect(
			expectSameUnder(
				"content",
				"x".repeat(LIMITS.maxTotalSourceContentBytes + 1),
				parse,
			),
		).toBe('"ok"');
	});

	test("writeStateForCandidate: evidence without own range is CORRUPT_ROW even if the prototype has one", () => {
		// 呼び出しごとに新しい DB を開く（catch した例外で transaction が commit されて次の呼び出しに残らないように）。
		const write = () => {
			const store = openTestStore();
			try {
				return store.write((db) => {
					try {
						writeStateForCandidate(db, {
							principal: ACCESS.principal,
							scopeKey: SCOPE,
							atMs: 1,
							subject: "self",
							kind: "preference",
							semanticKey: "drink",
							value: value("x"),
							evidence: [
								{
									source: {
										namespace: "conversation",
										kind: "message",
										id: "m1",
										revision: COFFEE.revision,
										digest: COFFEE.digest,
									},
								},
							],
							evidenceOrdinal: 1,
							origin: "admitted_extraction",
							candidateId: "cand:z",
							replaces: null,
						});
						return "no error";
					} catch (error) {
						return isMemoryStoreError(error) ? error.code : String(error);
					}
				});
			} finally {
				store.close();
			}
		};
		expect(expectSameUnder("range", { startByte: 0, endByte: 3 }, write)).toBe(
			'"CORRUPT_ROW"',
		);
	});

	test("settle: a current source without own content never supplies the quote body from the prototype", () => {
		const run = (content: string | null) => {
			const store = openTestStore();
			try {
				const source = makeSource("m11", "私は海が好き。", 7);
				const prepared = store.write((db) =>
					prepareExtraction(db, prepareInput("pj3", [extSource(source)])),
				);
				if (prepared.status !== "ready") throw new Error("not ready");
				const { content: _content, ...withoutContent } = current(source);
				const result = (): unknown =>
					store.write((db) =>
						settleExtraction(
							db,
							settleInput(
								"pj3",
								{
									noChange: false,
									candidates: [candidateOf(prepared.input, "海が好き")],
								},
								[withoutContent],
								{ ...DEFAULT_ADMISSION_POLICY, preference: "auto_admit" },
							),
						),
					);
				return content === null
					? JSON.stringify(result())
					: withPrototype("content", content, () => JSON.stringify(result()));
			} finally {
				store.close();
			}
		};
		const clean = run(null);
		expect(clean).toBe(
			'{"status":"applied","admitted":0,"pendingUser":0,"rejected":1}',
		);
		expect(run("私は海が好き。")).toBe(clean);
	});

	test("recordSourceStates: a ref without own representation is never treated as text via the prototype", () => {
		const store = openTestStore();
		try {
			const captured = store.write((db) =>
				captureRecord(db, {
					contractVersion: 1,
					access: RECORD_ACCESS,
					scopeKey: "scope:a",
					clock: { atMs: 1 },
					origin: { namespace: "web", kind: "page", id: "p9" },
					mediaType: "text/plain",
					content: "body",
					captureState: "complete",
				}),
			);
			if (captured.status !== "captured") throw new Error("not captured");
			const { representation: _representation, ...bareRef } = captured.ref;
			const states = () =>
				store.read((db) =>
					recordSourceStates(db, {
						contractVersion: 1,
						access: RECORD_ACCESS,
						scopeKey: "scope:a",
						refs: [bareRef],
					}),
				);
			const clean = expectSameUnder("representation", "text", states);
			expect(clean).toContain('"status":"missing"');
		} finally {
			store.close();
		}
	});
});

describe("Object.prototype pollution does not change results", () => {
	test("State: assert / edit / status changes / list / snapshot part", () => {
		expectInvariant(stateFlow);
	});

	test("Extraction: prepare / settle / list / confirm", () => {
		expectInvariant(extractionFlow);
	});

	test("Records and Lifecycle: capture / read / range / sourceStates / search / forget / external deletion", () => {
		expectInvariant(recordsFlow);
	});

	test("the harness detects a read of the prototype (self-check)", () => {
		// 汚染で実際に結果が変わる読み方があれば検出できること: includeInactive を own で読まない旧実装の模擬。
		const naive = (options: { includeInactive?: boolean }) =>
			options.includeInactive === true ? "all" : "active";
		const clean = naive({});
		const polluted = withPrototype("includeInactive", true, () => naive({}));
		expect(clean).toBe("active");
		expect(polluted).toBe("all");
	});

	test("the hostile table covers every optional key of the State / Extraction / Records / Lifecycle inputs", () => {
		for (const key of [
			"attributes",
			"validFromMs",
			"validUntilMs",
			"replaces",
			"kinds",
			"includeInactive",
			"limit",
			"decision",
			"editedValue",
			"representation",
			"range",
			"content",
			"revision",
			"runRef",
			"providerRef",
			"withContent",
			"cursor",
			"externalId",
			"origin",
			"evidenceOrdinal",
		]) {
			expect(Object.hasOwn(HOSTILE, key)).toBe(true);
		}
		// 汚染の窓は閉じている
		for (const key of Object.keys(HOSTILE)) {
			expect(Object.hasOwn(Object.prototype, key)).toBe(false);
		}
	});
});

void COFFEE;
