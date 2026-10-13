import { afterEach, describe, expect, test } from "bun:test";
import type { StateItem, StateWriteResult } from "../contracts/index.ts";
import { DEFAULT_ADMISSION_POLICY } from "../contracts/index.ts";
import { evaluateAdmission } from "../service/admission.ts";
import {
	assertUserState,
	deactivateState,
	editState,
	listState,
	readMemorySnapshotPart,
	readStateFact,
	retractState,
	writeStateForCandidate,
} from "../repository/index.ts";
import { latestMemoryChangeSeq } from "../../../infrastructure/sqlite/changes.ts";
import { openTestStore } from "../../../../test/support/store.ts";
import type { TestStore } from "../../../../test/support/store.ts";
import {
	ACCESS,
	COFFEE,
	OTHER_SCOPE,
	SCOPE,
	TEA,
	assertInput,
	editInput,
	makeSource,
	makeSpan,
	targetInput,
	value,
} from "./state-support.ts";

const stores: TestStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function open(): TestStore {
	const store = openTestStore();
	stores.push(store);
	return store;
}

function applied(result: StateWriteResult): StateItem {
	if (result.status !== "applied") {
		throw new Error(`expected applied, got ${JSON.stringify(result)}`);
	}
	return result.item;
}

const inferred = (overrides = {}) =>
	assertInput({ origin: "agent_inferred", ...overrides });

function candidateWrite(
	text: string,
	ordinal: number,
	source = COFFEE,
	quote = "コーヒーが好き",
): Parameters<typeof writeStateForCandidate>[1] {
	return {
		principal: ACCESS.principal,
		scopeKey: SCOPE,
		atMs: 500,
		subject: "self",
		kind: "preference",
		semanticKey: "drink",
		value: value(text),
		evidence: [makeSpan(source, quote)],
		evidenceOrdinal: ordinal,
		origin: "admitted_extraction",
		candidateId: `cand:${text}`,
		replaces: null,
	};
}

describe("agent_inferred through assertUserState / editState", () => {
	test("is stored with its own origin, listed and visible in the snapshot part", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, inferred())));
		expect(item.origin).toBe("agent_inferred");
		expect(item.status).toBe("active");
		const listed = s.read((db) =>
			listState(db, { contractVersion: 1, access: ACCESS, scopeKey: SCOPE }),
		);
		expect(listed.status === "ok" && listed.items[0]?.origin).toBe(
			"agent_inferred",
		);
		const part = s.read((db) =>
			readMemorySnapshotPart(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
			}),
		);
		expect(part.status === "ok" && part.items[0]?.origin).toBe(
			"agent_inferred",
		);
	});

	test("an unknown origin is still a contract error", () => {
		const s = open();
		expect(() =>
			s.write((db) =>
				assertUserState(db, assertInput({ origin: "agent" as never })),
			),
		).toThrow();
	});

	test("a later user_confirmed assertion replaces it with `replaces`, and promotes it when the value is the same", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, inferred())));
		const same = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ origin: "user_confirmed" })),
			),
		);
		expect(same).toMatchObject({
			itemId: item.itemId,
			origin: "user_confirmed",
			revision: 2,
		});
		const other = open();
		const first = applied(other.write((db) => assertUserState(db, inferred())));
		const replaced = applied(
			other.write((db) =>
				assertUserState(
					db,
					assertInput({
						origin: "user_confirmed",
						value: value("紅茶が好き"),
						evidence: [makeSpan(TEA, "紅茶が好き")],
						sources: [TEA],
						replaces: { itemId: first.itemId, revision: first.revision },
					}),
				),
			),
		);
		expect(replaced).toMatchObject({
			origin: "user_confirmed",
			status: "active",
		});
		expect(
			other.writer
				.query(
					"SELECT status, origin FROM memory_state_item ORDER BY created_seq",
				)
				.all(),
		).toEqual([
			{ status: "superseded", origin: "agent_inferred" },
			{ status: "active", origin: "user_confirmed" },
		]);
	});

	test("a same-value agent_inferred write never relabels a user-confirmed item, and editState promotes", () => {
		const s = open();
		const item = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ origin: "user_confirmed" })),
			),
		);
		expect(s.write((db) => assertUserState(db, inferred())).status).toBe(
			"unchanged",
		);
		const guess = open();
		const agent = applied(guess.write((db) => assertUserState(db, inferred())));
		const promoted = applied(
			guess.write((db) =>
				editState(
					db,
					editInput(agent.itemId, 1, {
						origin: "user_edited",
						value: value("コーヒーが好き"),
						evidence: [makeSpan(COFFEE, "コーヒーが好き")],
						sources: [COFFEE],
					}),
				),
			),
		);
		expect(promoted.origin).toBe("user_edited");
		expect(item.origin).toBe("user_confirmed");
	});

	test("editState accepts agent_inferred and records it as the origin of the new value", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, inferred())));
		const edited = applied(
			s.write((db) =>
				editState(db, editInput(item.itemId, 1, { origin: "agent_inferred" })),
			),
		);
		expect(edited).toMatchObject({ origin: "agent_inferred", revision: 2 });
	});
});

describe("agent_inferred gets none of the protections of user-confirmed items", () => {
	test("an extraction write with a newer evidence order supersedes it, an older one is OLDER_EVIDENCE", () => {
		const s = open();
		applied(s.write((db) => assertUserState(db, inferred())));
		const older = s.write((db) =>
			writeStateForCandidate(
				db,
				candidateWrite("紅茶が好き", 1, TEA, "紅茶が好き"),
			),
		);
		expect(older).toEqual({ status: "rejected", reasonCode: "OLDER_EVIDENCE" });
		const newer = s.write((db) =>
			writeStateForCandidate(
				db,
				candidateWrite("紅茶が好き", 9, TEA, "紅茶が好き"),
			),
		);
		expect(newer.status).toBe("applied");
		expect(
			s.writer
				.query(
					"SELECT status, origin FROM memory_state_item ORDER BY created_seq",
				)
				.all(),
		).toEqual([
			{ status: "superseded", origin: "agent_inferred" },
			{ status: "active", origin: "admitted_extraction" },
		]);
	});

	test("Admission: a differing candidate is not forced to pending_user over an agent_inferred active item (it is over a user-confirmed one)", () => {
		const source = makeSource("m9", "私は紅茶が好き", 9);
		const decide = (origin: "agent_inferred" | "user_confirmed") =>
			evaluateAdmission({
				candidate: {
					kind: "preference",
					subject: "self",
					semanticKey: "drink",
					value: { text: "紅茶が好き", polarity: "affirmed" },
					modality: "asserted",
					temporal: "current",
					evidence: [makeSpan(source, "紅茶が好き")],
				},
				principal: ACCESS.principal,
				scopeKey: SCOPE,
				inputSources: [{ ...source, role: "user" }],
				currentSources: [source],
				activeForKey: {
					itemId: "state:x",
					subject: "self",
					kind: "preference",
					semanticKey: "drink",
					status: "active",
					revision: 1,
					value: value("コーヒーが好き"),
					origin,
					evidenceOrdinal: 1,
				},
				policy: { ...DEFAULT_ADMISSION_POLICY, preference: "auto_admit" },
			});
		expect(decide("agent_inferred")).toEqual({ decision: "admitted" });
		expect(decide("user_confirmed")).toEqual({
			decision: "pending_user",
			reasonCode: "POLICY_REQUIRES_USER",
		});
	});

	test("a stopped agent_inferred item blocks extraction only because the host stopped it (user act), not because of its origin", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, inferred())));
		// 停止の操作自体が cause_type 'user' の event になる: 抽出は復活させない。
		s.write((db) => deactivateState(db, targetInput(item.itemId, 1)));
		expect(
			s.write((db) =>
				writeStateForCandidate(
					db,
					candidateWrite("紅茶が好き", 9, TEA, "紅茶が好き"),
				),
			),
		).toEqual({ status: "rejected", reasonCode: "INVALID_TRANSITION" });
		// 別 key の inactive でも agent_inferred の origin だけでは保護にならない: event を消すと保護も消える。
		s.writer
			.query(
				"DELETE FROM memory_state_event WHERE item_id = ? AND action = 'deactivate'",
			)
			.run(item.itemId);
		expect(
			s.write((db) =>
				writeStateForCandidate(
					db,
					candidateWrite("紅茶が好き", 9, TEA, "紅茶が好き"),
				),
			).status,
		).toBe("applied");
	});

	test("the host can retract an agent_inferred item and assert the key again", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, inferred())));
		applied(s.write((db) => retractState(db, targetInput(item.itemId, 1))));
		const again = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ origin: "user_confirmed" })),
			),
		);
		expect(again.origin).toBe("user_confirmed");
	});
});

describe("readStateFact", () => {
	const read = (s: TestStore, itemId: string, scopeKey = SCOPE) =>
		s.read((db) =>
			readStateFact(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey,
				itemId,
			}),
		);

	test("lists every non-forgotten version of the same fact, oldest first, beyond the listState view", () => {
		const s = open();
		const first = applied(s.write((db) => assertUserState(db, inferred())));
		const second = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						origin: "user_confirmed",
						value: value("紅茶が好き"),
						evidence: [makeSpan(TEA, "紅茶が好き")],
						sources: [TEA],
						replaces: { itemId: first.itemId, revision: 1 },
					}),
				),
			),
		);
		const other = applied(
			s.write((db) =>
				assertUserState(db, assertInput({ semanticKey: "food" })),
			),
		);
		for (const id of [first.itemId, second.itemId]) {
			expect(read(s, id)).toEqual({
				status: "ok",
				subject: "self",
				kind: "preference",
				semanticKey: "drink",
				itemIds: [first.itemId, second.itemId],
			});
		}
		expect(read(s, other.itemId)).toMatchObject({ itemIds: [other.itemId] });
	});

	test("stopped and retracted versions are included; forgotten and tombstoned ones are not", () => {
		const s = open();
		const first = applied(s.write((db) => assertUserState(db, inferred())));
		applied(s.write((db) => retractState(db, targetInput(first.itemId, 1))));
		const second = applied(s.write((db) => assertUserState(db, assertInput())));
		const third = applied(
			s.write((db) =>
				assertUserState(
					db,
					assertInput({
						value: value("紅茶が好き"),
						evidence: [makeSpan(TEA, "紅茶が好き")],
						sources: [TEA],
						replaces: { itemId: second.itemId, revision: 1 },
					}),
				),
			),
		);
		expect(read(s, third.itemId)).toMatchObject({
			itemIds: [first.itemId, second.itemId, third.itemId],
		});
		s.writer
			.query(
				"INSERT INTO memory_tombstone (target_type, target_id, principal, scope_key, forget_id, seq, journal_seq) VALUES ('state_item', ?, ?, ?, 'f1', 99, 1)",
			)
			.run(first.itemId, ACCESS.principal, SCOPE);
		s.writer
			.query(
				"UPDATE memory_state_item SET status = 'forgotten', value_text = NULL, polarity = NULL, semantic_key = '' WHERE item_id = ?",
			)
			.run(second.itemId);
		expect(read(s, third.itemId)).toMatchObject({ itemIds: [third.itemId] });
		expect(read(s, first.itemId)).toEqual({ status: "forgotten" });
		expect(read(s, second.itemId)).toEqual({ status: "forgotten" });
	});

	test("another scope or unknown id is missing, an unpermitted scope is blocked, garbage is a contract error", () => {
		const s = open();
		const item = applied(s.write((db) => assertUserState(db, assertInput())));
		expect(read(s, item.itemId, OTHER_SCOPE)).toEqual({ status: "missing" });
		expect(read(s, "state:nope")).toEqual({ status: "missing" });
		expect(
			s.read((db) =>
				readStateFact(db, {
					contractVersion: 1,
					access: { ...ACCESS, scopeKeys: [OTHER_SCOPE] },
					scopeKey: SCOPE,
					itemId: item.itemId,
				}),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
		expect(() =>
			s.read((db) => readStateFact(db, { itemId: item.itemId } as never)),
		).toThrow();
	});
});

describe("latestMemoryChangeSeq", () => {
	const latest = (s: TestStore, scopeKeys = [SCOPE]) =>
		s.read((db) =>
			latestMemoryChangeSeq(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKeys,
			}),
		);

	test("is 0 without changes and follows the newest visible change, per scope and principal", () => {
		const s = open();
		expect(latest(s)).toEqual({ status: "ok", seq: 0 });
		const item = applied(s.write((db) => assertUserState(db, assertInput())));
		const afterAssert = latest(s);
		expect(afterAssert.status === "ok" && afterAssert.seq).toBeGreaterThan(0);
		applied(s.write((db) => retractState(db, targetInput(item.itemId, 1))));
		const afterRetract = latest(s);
		expect(
			afterAssert.status === "ok" &&
				afterRetract.status === "ok" &&
				afterRetract.seq > afterAssert.seq,
		).toBe(true);
		const maxSeq = (
			s.writer
				.query(
					"SELECT MAX(seq) AS seq FROM memory_change WHERE principal = ? AND scope_key = ?",
				)
				.get(ACCESS.principal, SCOPE) as { seq: number }
		).seq;
		expect(afterRetract).toEqual({ status: "ok", seq: maxSeq });
		// 別 scope の書き込みは数えない
		expect(latest(s, [OTHER_SCOPE])).toEqual({ status: "ok", seq: 0 });
		// 別 principal の変更は数えない
		const foreign = s.read((db) =>
			latestMemoryChangeSeq(db, {
				contractVersion: 1,
				access: { ...ACCESS, principal: "local:other" },
				scopeKeys: [SCOPE],
			}),
		);
		expect(foreign).toEqual({ status: "ok", seq: 0 });
	});

	test("a scope outside access.scopeKeys is blocked; garbage is a contract error", () => {
		const s = open();
		expect(
			s.read((db) =>
				latestMemoryChangeSeq(db, {
					contractVersion: 1,
					access: { ...ACCESS, scopeKeys: [SCOPE] },
					scopeKeys: [OTHER_SCOPE],
				}),
			),
		).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
		expect(() =>
			s.read((db) =>
				latestMemoryChangeSeq(db, { scopeKeys: [SCOPE] } as never),
			),
		).toThrow();
	});
});
