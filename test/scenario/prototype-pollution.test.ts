/**
 * Object.prototype 汚染の回帰テスト（State / Records / Lifecycle の主要入口）。
 *
 * parse 済みの plain object や、条件付き spread で作った内部オブジェクトは Object.prototype を継承する。
 * 省略可能キーの有無を `=== undefined` / `??` で読むと、プロトタイプに仕込まれた値を拾ってしまう。
 * 各省略可能キーを 1 つずつ Object.prototype に仕込み（敵対的だが型としては有効な値）、同じ操作列を実行して、
 * 結果（戻り値 + DB の全 memory_ 行）が汚染なしの実行と一致することを確かめる。
 * 汚染の窓は操作の実行中だけ（finally で必ず外す）。期待値の比較は窓の外。
 */
import { describe, expect, test } from "bun:test";
import { openTestStore } from "../support/store.ts";
import { isMemoryContractError } from "../../src/contracts/errors.ts";
import { quoteMatches } from "../../src/domains/state/index.ts";
import { parseAssertUserStateInput } from "../../src/domains/state/index.ts";
import { applyStateTransition } from "../../src/domains/state/index.ts";
import { stateValueEquals } from "../../src/domains/state/index.ts";
import type { TestStore } from "../support/store.ts";
import type { AccessContext } from "../../src/contracts/types.ts";
import type { MemoryDb } from "../../src/infrastructure/sqlite/db.ts";
import {
	applyForget,
	planForget,
	recordExternalDeletion,
} from "../../src/domains/lifecycle/sqlite.ts";
import { captureRecord, readRecord } from "../../src/domains/records/sqlite.ts";
import {
	assertUserState,
	deactivateState,
	listState,
	reactivateState,
	retractState,
} from "../../src/domains/state/sqlite.ts";
import {
	ACCESS,
	COFFEE,
	SCOPE,
	TEA,
	assertInput,
	makeSpan,
	targetInput,
	value,
} from "../../src/domains/state/testing.ts";
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
	// Records / Lifecycle
	revision: "evil",
	providerRef: "evil",
	externalId: "evil",
	// 判別用の内部結果（`"reasonCode" in x` ではなく own で判定する）
	reasonCode: "SOURCE_STALE",
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
		"deactivate",
		w((db) => deactivateState(db, targetInput(itemId, 1))),
	);
	log(
		"list-after-deactivate",
		store.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		),
	);
	log(
		"reactivate",
		w((db) => reactivateState(db, targetInput(itemId, 2))),
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
					replaces: { itemId, revision: 3 },
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
		"retract",
		w((db) => retractState(db, targetInput(itemId, 3))),
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

	test("quoteMatches: a span without own range never matches", () => {
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
		const supersede = {
			action: "supersede" as const,
			expectedRevision: 1,
			cause,
		};
		const assertion = {
			action: "assert" as const,
			expectedRevision: null,
			cause,
		};
		// 1 つだけ欠けた遷移: 欠けたキーをプロトタイプから補われても INVALID_TRANSITION のまま
		const full = {
			identity: {
				itemId: "state:n",
				subject: "self" as const,
				kind: "preference" as const,
				semanticKey: "drink",
			},
			value: value("z"),
			origin: "agent_inferred" as const,
			evidenceOrdinal: 3,
		};
		for (const key of Object.keys(full) as (keyof typeof full)[]) {
			const { [key]: hostile, ...rest } = full;
			expect(
				expectSameUnder(key, hostile, () =>
					applyStateTransition(
						view,
						{ ...supersede, ...rest },
						{ atMs: 1, activeForKey: view },
					),
				),
			).toContain("INVALID_TRANSITION");
			expect(
				expectSameUnder(key, hostile, () =>
					applyStateTransition(
						null,
						{ ...assertion, ...rest },
						{ atMs: 1, activeForKey: null },
					),
				),
			).toContain("INVALID_TRANSITION");
		}
	});

	test("input parse: an evidence span without own range is MISSING_KEY", () => {
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
	});
});

describe("Object.prototype pollution does not change results", () => {
	test("State: assert / status changes / list", () => {
		expectInvariant(stateFlow);
	});

	test("Records and Lifecycle: capture / read / forget / external deletion", () => {
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

	test("the hostile table covers every optional key of the State / Records / Lifecycle inputs", () => {
		for (const key of [
			"attributes",
			"validFromMs",
			"validUntilMs",
			"replaces",
			"kinds",
			"includeInactive",
			"limit",
			"representation",
			"range",
			"content",
			"revision",
			"providerRef",
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
