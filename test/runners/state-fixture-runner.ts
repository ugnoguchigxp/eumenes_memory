/**
 * `fixtures/state/*.json`（State 台帳の遷移 reducer の言語非依存 fixture）の実行器。src を import せず、
 * API を引数で受け取る。期待値は fixture に手書きされ、実装から導出しない。
 *
 * fixture の形（fixtureFormat 1）:
 * - `steps[]` を順に実行する。runner は item の名前（`as` / `target`）から状態を持つ小さな台帳で、
 *   各 step の `current`（target の現在像）と `activeForKey`（同 subject・kind・semanticKey の active）を作る。
 *   itemId は `"item:" + 名前`。
 * - step: `{ action, target?, as?, identity?, expectedRevision, value?, origin?, evidenceOrdinal?, cause?, atMs?, expect }`。
 *   `assert` は `identity` ({subject, kind, semanticKey}) と `as`（新 item の名前）。`supersede` は `target`（旧）と
 *   `as`（新）で、新の identity は target と同じ。それ以外は `target`。
 * - `expect`: `{ ok: false, reasonCode }` または `{ ok: true, items: [{as, status, revision, valueText?, origin?}], events: [{as, action, from, to}] }`。
 *   `items` / `events` が空なら冪等（unchanged）。items と events は順序も比べる。
 * - runner は同 key の履歴から `context.keyHistory` も作る: `disputedMaxOrdinal` = 台帳の disputed の item の evidenceOrdinal の最大
 *   （なければ null）、`userRemoved` = origin が user_confirmed / user_edited の item が retracted / inactive で台帳にある。
 * - 各 step の後に不変条件を検査する: 同 (subject, kind, semanticKey) の active は高々 1 件、revision は減らない。
 * - `finalStatuses`（任意）: 最後の台帳の名前 → status。
 */
import { describe, expect, test } from "bun:test";
import { loadFixtures } from "../fixture-runner.ts";

type Obj = Record<string, unknown>;

export interface StateFixtureApi {
	applyStateTransition(
		current: unknown,
		transition: unknown,
		context: unknown,
	): unknown;
}

interface Item {
	itemId: string;
	subject: string;
	kind: string;
	semanticKey: string;
	status: string;
	revision: number;
	value: unknown;
	origin: string;
	evidenceOrdinal: number;
}

const DEFAULT_CAUSE = { type: "user", id: "fixture" };

function asObj(value: unknown): Obj {
	return value as Obj;
}

export function describeStateFixtures(api: StateFixtureApi): void {
	describe("state fixtures (reducer)", () => {
		for (const fixture of loadFixtures("state")) {
			test(String(fixture["id"]), () => {
				const ledger = new Map<string, Item>(); // 名前 -> item
				const nameOf = (itemId: string): string => itemId.slice("item:".length);
				const steps = fixture["steps"] as Obj[];
				for (const [index, step] of steps.entries()) {
					const label = `${String(fixture["id"])} step ${index}`;
					const target =
						typeof step["target"] === "string"
							? ledger.get(step["target"])
							: undefined;
					if (typeof step["target"] === "string" && target === undefined) {
						throw new Error(`${label}: unknown target`);
					}
					const identitySource: Obj | undefined =
						step["identity"] !== undefined
							? asObj(step["identity"])
							: target !== undefined
								? { ...target }
								: undefined;
					const newName = typeof step["as"] === "string" ? step["as"] : null;
					const transition: Obj = {
						action: step["action"],
						expectedRevision: step["expectedRevision"] ?? null,
						cause: step["cause"] ?? DEFAULT_CAUSE,
					};
					for (const key of ["value", "origin", "evidenceOrdinal"]) {
						if (step[key] !== undefined) transition[key] = step[key];
					}
					if (newName !== null && identitySource !== undefined) {
						transition["identity"] = {
							itemId: `item:${newName}`,
							subject: identitySource["subject"],
							kind: identitySource["kind"],
							semanticKey: identitySource["semanticKey"],
						};
					}
					const keyOf = identitySource;
					const activeForKey =
						keyOf === undefined
							? null
							: ([...ledger.values()].find(
									(item) =>
										item.status === "active" &&
										item.subject === keyOf["subject"] &&
										item.kind === keyOf["kind"] &&
										item.semanticKey === keyOf["semanticKey"],
								) ?? null);
					const sameKey = (item: Item): boolean =>
						keyOf !== undefined &&
						item.subject === keyOf["subject"] &&
						item.kind === keyOf["kind"] &&
						item.semanticKey === keyOf["semanticKey"];
					const sameKeyItems = [...ledger.values()].filter(sameKey);
					const disputedOrdinals = sameKeyItems
						.filter((item) => item.status === "disputed")
						.map((item) => item.evidenceOrdinal);
					const keyHistory = {
						disputedMaxOrdinal:
							disputedOrdinals.length === 0
								? null
								: Math.max(...disputedOrdinals),
						userRemoved: sameKeyItems.some(
							(item) =>
								(item.status === "retracted" || item.status === "inactive") &&
								(item.origin === "user_confirmed" ||
									item.origin === "user_edited"),
						),
					};
					const result = asObj(
						api.applyStateTransition(target ?? null, transition, {
							atMs: step["atMs"] ?? 1000,
							activeForKey,
							keyHistory,
						}),
					);
					const expected = asObj(step["expect"]);
					expect(result["ok"], label).toBe(expected["ok"]);
					if (expected["ok"] === false) {
						expect(result["reasonCode"], label).toBe(expected["reasonCode"]);
					} else {
						const items = result["items"] as Item[];
						const events = result["events"] as Obj[];
						expect<unknown>(
							items.map((item) => ({
								as: nameOf(item.itemId),
								status: item.status,
								revision: item.revision,
							})),
							label,
						).toEqual(
							(expected["items"] as Obj[]).map((e) => ({
								as: e["as"],
								status: e["status"],
								revision: e["revision"],
							})),
						);
						for (const [i, e] of (expected["items"] as Obj[]).entries()) {
							const item = items[i];
							if (e["valueText"] !== undefined) {
								expect<unknown>(asObj(item?.value)["text"], label).toBe(
									e["valueText"],
								);
							}
							if (e["origin"] !== undefined) {
								expect<unknown>(item?.origin, label).toBe(e["origin"]);
							}
						}
						expect<unknown>(
							events.map((event) => ({
								as: nameOf(String(event["itemId"])),
								action: event["action"],
								from: event["fromRevision"],
								to: event["toRevision"],
								atMs: event["atMs"],
							})),
							label,
						).toEqual(
							(expected["events"] as Obj[]).map((e) => ({
								as: e["as"],
								action: e["action"],
								from: e["from"],
								to: e["to"],
								atMs: step["atMs"] ?? 1000,
							})),
						);
						for (const item of items) {
							const previous = ledger.get(nameOf(item.itemId));
							if (previous !== undefined) {
								expect(item.revision, label).toBeGreaterThanOrEqual(
									previous.revision,
								);
							}
							ledger.set(nameOf(item.itemId), item);
						}
					}
					// 不変条件: 同 key の active は高々 1 件。
					const seen = new Set<string>();
					for (const item of ledger.values()) {
						if (item.status !== "active") continue;
						const key = JSON.stringify([
							item.subject,
							item.kind,
							item.semanticKey,
						]);
						expect(seen.has(key), `${label}: two active for ${key}`).toBe(
							false,
						);
						seen.add(key);
					}
				}
				const finalStatuses = fixture["finalStatuses"];
				if (finalStatuses !== undefined) {
					const actual: Record<string, string> = {};
					for (const name of Object.keys(asObj(finalStatuses))) {
						actual[name] = ledger.get(name)?.status ?? "(absent)";
					}
					expect(actual).toEqual(
						asObj(finalStatuses) as Record<string, string>,
					);
				}
			});
		}
	});
}
