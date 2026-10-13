/**
 * fixtures/lifecycle の `forget-db`（宣言的な依存グラフ → 実 SQLite → 実 forget）の実行器。
 * 期待値は fixture が手で持ち、実装からも `expectedForgotten`（oracle）からも導出しない。
 *
 * fixture の形（kind `forget-db`）:
 * - input.graph: `GraphSpec`（`forget-support.ts`）。input.forget: `ForgetTargetSpec[]` を順に plan → apply する。
 * - expect.forgotten / expect.kept: 型ごとの ID。forgotten は墓標が付き、kept は付かない（state_item は status も確認）。
 * - expect.tombstonedSources: 墓標 `source` が付く出典の参照（`m:` / `r:`）。厳密一致。
 * - expect.receipt: 最後の forget の receipt（external 集約、completed、`provider/externalId|-:state` の一覧）。
 * - expect.valuesGone / valuesPresent: 行の値（`i:` / `r:`）が memory_ 表のどこかに残るか。
 */
import { describe, expect, test } from "bun:test";
import { loadFixtures } from "../fixture-runner.ts";
import { openTestStore } from "../support/store.ts";
import {
	buildGraph,
	closureViolations,
	toForgetTarget,
	tombstoneSet,
} from "./forget-support.ts";
import type { ForgetTargetSpec, GraphSpec } from "./forget-support.ts";
import { forgetRecord, tablesContain } from "./records-support.ts";

type Obj = Record<string, unknown>;

const TYPES = ["state_item", "external"] as const;

export function describeForgetDbFixtures(): void {
	describe("lifecycle fixtures (forget over a real SQLite graph)", () => {
		for (const fixture of loadFixtures("lifecycle")) {
			if (fixture["kind"] !== "forget-db") continue;
			test(String(fixture["id"]), () => {
				const input = fixture["input"] as Obj;
				const expectation = fixture["expect"] as Obj;
				const store = openTestStore({ inMemory: true });
				try {
					const graph = buildGraph(store, input["graph"] as GraphSpec);
					let receipt = null as
						| ReturnType<typeof forgetRecord>["receipt"]
						| null;
					for (const target of input["forget"] as ForgetTargetSpec[]) {
						receipt = forgetRecord(
							store,
							toForgetTarget(graph, target) as never,
						).receipt;
					}
					const forgotten = expectation["forgotten"] as Record<
						string,
						string[]
					>;
					const kept = expectation["kept"] as Record<string, string[]>;
					for (const type of TYPES) {
						expect({
							type,
							ids: [...tombstoneSet(store, type)].sort(),
						}).toEqual({ type, ids: [...(forgotten[type] ?? [])].sort() });
						for (const id of kept[type] ?? []) {
							expect({
								type,
								id,
								tombstoned: tombstoneSet(store, type).has(id),
							}).toEqual({
								type,
								id,
								tombstoned: false,
							});
						}
					}
					for (const id of kept["state_item"] ?? []) {
						expect(
							store.writer
								.query("SELECT status FROM memory_state_item WHERE item_id = ?")
								.get(id),
						).toEqual({ status: "active" });
					}
					for (const id of forgotten["state_item"] ?? []) {
						expect(
							store.writer
								.query(
									"SELECT status, value_text FROM memory_state_item WHERE item_id = ?",
								)
								.get(id),
						).toEqual({ status: "forgotten", value_text: null });
					}
					expect([...tombstoneSet(store, "source")].sort()).toEqual(
						(expectation["tombstonedSources"] as string[])
							.map((ref) => graph.sourceKeyOf(ref))
							.sort(),
					);
					const wanted = expectation["receipt"] as Obj;
					expect(receipt).not.toBeNull();
					expect({
						external: receipt?.external,
						completed: receipt?.completed,
						deletions: receipt?.externalDeletions.map(
							(d) => `${d.providerRef}/${d.externalId ?? "-"}:${d.state}`,
						),
					}).toEqual({
						external: wanted["external"] as never,
						completed: wanted["completed"] as boolean,
						deletions: wanted["deletions"] as string[],
					});
					for (const ref of expectation["valuesGone"] as string[]) {
						for (const secret of graph.secrets.get(ref) ?? []) {
							expect({ ref, found: tablesContain(store, secret) }).toEqual({
								ref,
								found: false,
							});
						}
						expect(graph.secrets.has(ref)).toBe(true);
					}
					for (const ref of expectation["valuesPresent"] as string[]) {
						for (const secret of graph.secrets.get(ref) ?? []) {
							expect({ ref, found: tablesContain(store, secret) }).toEqual({
								ref,
								found: true,
							});
						}
						expect(graph.secrets.has(ref)).toBe(true);
					}
					expect(closureViolations(store)).toEqual([]);
				} finally {
					store.close();
				}
			});
		}
	});
}
