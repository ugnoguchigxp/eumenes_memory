/**
 * fixtures/lifecycle の実行（ジャーナル entry の canonical / hash 鎖、閉包計算）。純粋関数だけを対象にする。
 * 期待値（hash・forgetId・閉包）は fixture 側が持ち、独立の SHA-256 実装（node:crypto）でも照合する。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { loadFixtures } from "../fixture-runner.ts";

type Obj = Record<string, unknown>;

export interface LifecycleApi {
	buildJournalEntry(args: {
		seq: number;
		prevHash: string;
		principal: string;
		targets: readonly unknown[];
	}): unknown;
	verifyForgetJournal(entries: readonly unknown[]): unknown;
	computeClosure(
		edges: readonly unknown[],
		starts: readonly unknown[],
	): unknown;
}

export function describeLifecycleFixtures(api: LifecycleApi): void {
	describe("lifecycle fixtures (journal, closure)", () => {
		for (const fixture of loadFixtures("lifecycle")) {
			// `forget-db` は実 SQLite の実行器（forget-db.ts）が扱う。
			if (fixture["kind"] === "forget-db") continue;
			test(String(fixture["id"]), () => {
				const input = fixture["input"] as Obj;
				const expectation = fixture["expect"] as Obj;
				switch (fixture["kind"]) {
					case "entry": {
						const entry = api.buildJournalEntry(input as never) as Obj;
						expect(entry).toEqual(expectation["entry"] as Obj);
						// hash は fixture が持つ canonical 文字列の SHA-256 と独立に一致する
						expect(
							createHash("sha256")
								.update(expectation["hashInput"] as string, "utf8")
								.digest("hex"),
						).toBe(entry["hash"] as string);
						if (entry["seq"] === 1) {
							expect(api.verifyForgetJournal([entry])).toEqual({
								status: "ok",
								head: { seq: 1, hash: entry["hash"] },
							} as never);
						}
						break;
					}
					case "chain":
						expect(
							api.verifyForgetJournal(input["entries"] as unknown[]),
						).toEqual(expectation as never);
						break;
					case "closure": {
						const closure = api.computeClosure(
							input["edges"] as unknown[],
							input["starts"] as unknown[],
						);
						expect(closure).toEqual(expectation as never);
						break;
					}
					default:
						throw new Error(`unknown fixture kind ${String(fixture["kind"])}`);
				}
			});
		}
	});
}
