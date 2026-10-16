import { expect, test } from "bun:test";
import { openTestStore } from "../../../../test/support/store.ts";
import {
	assertUserState,
	listState,
	deactivateState,
} from "../repository/index.ts";
import { assertInput, ACCESS, SCOPE, targetInput } from "./state-support.ts";
import type { ListStateInput, StateItem } from "../contracts/index.ts";

const query = { contractVersion: 1 as const, access: ACCESS, scopeKey: SCOPE };
test("pagination reaches all 1001 facts and exposes truncation without duplicates", () => {
	const s = openTestStore();
	try {
		s.write((db) => {
			for (let i = 0; i < 1001; i++)
				assertUserState(db, assertInput({ semanticKey: `topic-${i}` }));
		});
		s.read((db) => {
			const first = listState(db, query);
			expect(first.status).toBe("ok");
			if (first.status !== "ok") return;
			expect(first.items.length).toBe(1000);
			expect(first.nextCursor).toBeDefined();
			const next = listState(db, { ...query, after: first.nextCursor! });
			if (next.status !== "ok") throw Error(next.status);
			expect(next.items.length).toBe(1);
			expect(next.nextCursor).toBeUndefined();
			expect(
				new Set([...first.items, ...next.items].map((x) => x.itemId)).size,
			).toBe(1001);
		});
	} finally {
		s.close();
	}
});
test("cursor validates values and preserves access, inactive and kind filters", () => {
	const s = openTestStore();
	try {
		const items: StateItem[] = [];
		s.write((db) => {
			for (let i = 0; i < 4; i++) {
				const r = assertUserState(
					db,
					assertInput({
						semanticKey: `topic-${i}`,
						kind: i % 2 ? "habit" : "preference",
					}),
				);
				if (r.status === "applied") items.push(r.item);
			}
		});
		s.write((db) =>
			deactivateState(db, targetInput(items[0]!.itemId, items[0]!.revision)),
		);
		s.read((db) => {
			const page = listState(db, { ...query, limit: 1, kinds: ["preference"] });
			if (page.status !== "ok") throw Error(page.status);
			expect(page.items.length).toBe(1);
			expect(page.nextCursor).toBeUndefined();
			const denied = listState(db, {
				...query,
				access: { ...ACCESS, scopeKeys: [] },
				after: { updatedSeq: 100, itemId: items[0]!.itemId },
			});
			expect(denied.status).toBe("blocked");
			const other = listState(db, {
				...query,
				access: { ...ACCESS, principal: "another" },
			});
			expect(other).toEqual({ status: "ok", items: [] });
			for (const after of [
				{ updatedSeq: 0, itemId: "x" },
				{ updatedSeq: 1.5, itemId: "x" },
				{ updatedSeq: 1, itemId: "" },
				{ updatedSeq: 1, itemId: "x", extra: 1 },
			])
				expect(() =>
					listState(db, { ...query, after } as ListStateInput),
				).toThrow();
		});
	} finally {
		s.close();
	}
});
test("one read transaction keeps pagination consistent across another connection's write", () => {
	const s = openTestStore();
	try {
		s.write((db) => {
			for (let i = 0; i < 3; i++)
				assertUserState(db, assertInput({ semanticKey: `topic-${i}` }));
		});
		s.read((db) => {
			const first = listState(db, { ...query, limit: 1 });
			if (first.status !== "ok") throw Error(first.status);
			s.write((writer) =>
				assertUserState(writer, assertInput({ semanticKey: "new" })),
			);
			const rest = listState(db, { ...query, after: first.nextCursor! });
			if (rest.status !== "ok") throw Error(rest.status);
			expect(rest.items.length).toBe(2);
			expect(rest.items.some((x) => x.semanticKey === "new")).toBe(false);
		});
		s.read((db) => {
			const page = listState(db, query);
			if (page.status !== "ok") throw Error(page.status);
			expect(page.items.length).toBe(4);
		});
	} finally {
		s.close();
	}
});

test("pagination keeps both items sharing an update sequence and retains inactive filtering", () => {
	const s = openTestStore();
	try {
		const first = s.write((db) => assertUserState(db, assertInput()));
		if (first.status !== "applied") throw Error(first.status);
		const next = s.write((db) =>
			assertUserState(
				db,
				assertInput({
					value: { text: "紅茶が好き", polarity: "affirmed" },
					replaces: {
						itemId: first.item.itemId,
						revision: first.item.revision,
					},
				}),
			),
		);
		if (next.status !== "applied") throw Error(next.status);
		s.read((db) => {
			const a = listState(db, { ...query, includeInactive: true, limit: 1 });
			if (a.status !== "ok") throw Error(a.status);
			const b = listState(db, {
				...query,
				includeInactive: true,
				limit: 1,
				after: a.nextCursor!,
			});
			if (b.status !== "ok") throw Error(b.status);
			expect(a.items[0]!.updatedSeq).toBe(b.items[0]!.updatedSeq);
			expect(new Set([...a.items, ...b.items].map((x) => x.itemId)).size).toBe(
				2,
			);
			expect(b.nextCursor).toBeUndefined();
		});
	} finally {
		s.close();
	}
});
