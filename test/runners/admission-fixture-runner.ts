/**
 * `fixtures/admission/*.json`（Admission 規則表の言語非依存 fixture）の実行器。src を import せず API を引数で受け取る。
 * 期待値は fixture に手書きされ、実装から導出しない。
 *
 * fixture の形（fixtureFormat 1）。固定の前提: principal `local:owner`、scope `conversation:c1`、出典は
 * namespace `conversation` / kind `message` / representation `text`。
 * - `sources[]`: `{ name, role, ordinal, content }`。id = name、digest = content の UTF-8 の SHA-256 hex、
 *   revision = `"sha256:" + digest`。run 入力と、判定時点の現在状態（既定は同じで status `available`）になる。
 * - `currentOverrides`（任意）: name → `{ status?, content?, absent? }`。現在状態だけを変える
 *   （`content` を変えると revision / digest が変わる＝版変更、`absent: true` で現在状態から消す）。
 * - `candidate`: `{ kind, subject, semanticKey, value, modality, temporal, evidence[] }`。
 *   evidence 要素: `{ source, quote, locate?, range?, refContent? }`。range は既定で `locate ?? quote` の
 *   source 本文内の最初の出現の UTF-8 byte 範囲、`range: [start, end]` で上書き。`source` が `sources` に無ければ
 *   入力にない出典。`refContent` はその文字列から ref の revision / digest を作る（入力と版が違う ref）。
 * - `activeForKey`（任意、既定 null）: `{ value, evidenceOrdinal, origin? }`（subject / semanticKey は candidate と同じ、kind は
 *   `kind`（任意、既定 candidate.kind）、status active、revision 1）。`origin` の既定は `admitted_extraction`
 *   （`user_confirmed` / `user_edited` を指定すると、抽出由来はその項目を黙って上書きせず pending_user になる）。
 * - `keyHistory`（任意）: `{ disputedMaxOrdinal: number | null, userRemoved: boolean }`。同 key の active 以外の履歴
 *   （disputed の最新の根拠順位、ユーザー由来 item を retract / deactivate 済みか）。省略は履歴なし。
 * - `note` / `stage`（任意、読み飛ばす）: 規則では止められない既知の限界（極性誤りなど）を書く。`stage: "E"` は
 *   「この誤りは規則では検出できず、実モデル評価（E 段階）で測る」の意味。期待値は規則の現在の挙動（admitted など）。
 * - `policy`（任意）: `{ all?: mode, <kind>?: mode }`。既定は全 kind `user_confirm`。
 * - `expect`: `{ decision, reasonCode?, effectiveKind? }`。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { loadFixtures } from "../fixture-runner.ts";

type Obj = Record<string, unknown>;

export interface AdmissionFixtureApi {
	evaluateAdmission(input: unknown): unknown;
	effectiveCandidateKind(candidate: unknown): unknown;
}

const PRINCIPAL = "local:owner";
const SCOPE = "conversation:c1";
const KINDS = [
	"preference",
	"personal_fact",
	"constraint",
	"habit",
	"other_person_note",
];

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function sourceState(name: string, content: string, extra: Obj = {}): Obj {
	const digest = sha256(content);
	return {
		namespace: "conversation",
		kind: "message",
		id: name,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: PRINCIPAL,
		scopeKey: SCOPE,
		status: "available",
		...extra,
	};
}

function byteRange(content: string, needle: string): [number, number] {
	const index = content.indexOf(needle);
	if (index < 0) throw new Error(`locate text not found: ${needle}`);
	const start = Buffer.byteLength(content.slice(0, index), "utf8");
	return [start, start + Buffer.byteLength(needle, "utf8")];
}

export function describeAdmissionFixtures(api: AdmissionFixtureApi): void {
	describe("admission fixtures", () => {
		for (const fixture of loadFixtures("admission")) {
			test(String(fixture["id"]), () => {
				const sources = (fixture["sources"] as Obj[]).map((source) => ({
					...sourceState(String(source["name"]), String(source["content"])),
					role: source["role"],
					ordinal: source["ordinal"],
					content: source["content"],
				}));
				const contentOf = new Map(
					(fixture["sources"] as Obj[]).map((s) => [
						String(s["name"]),
						String(s["content"]),
					]),
				);
				const overrides = (fixture["currentOverrides"] ?? {}) as Record<
					string,
					Obj
				>;
				const currentSources: Obj[] = [];
				for (const source of fixture["sources"] as Obj[]) {
					const name = String(source["name"]);
					const override = overrides[name] ?? {};
					if (override["absent"] === true) continue;
					const content =
						typeof override["content"] === "string"
							? override["content"]
							: String(source["content"]);
					currentSources.push(
						sourceState(
							name,
							content,
							typeof override["status"] === "string"
								? { status: override["status"] }
								: {},
						),
					);
				}
				const candidateIn = fixture["candidate"] as Obj;
				const evidence = (candidateIn["evidence"] as Obj[]).map((span) => {
					const name = String(span["source"]);
					const content = contentOf.get(name);
					const base = sourceState(
						name,
						typeof span["refContent"] === "string"
							? span["refContent"]
							: (content ?? `absent-${name}`),
					);
					const range = Array.isArray(span["range"])
						? (span["range"] as [number, number])
						: byteRange(content ?? "", String(span["locate"] ?? span["quote"]));
					const ref: Obj = {
						namespace: base["namespace"],
						kind: base["kind"],
						id: base["id"],
						representation: base["representation"],
						revision: base["revision"],
						digest: base["digest"],
						range: { startByte: range[0], endByte: range[1] },
					};
					return { source: ref, quote: span["quote"] };
				});
				const candidate: Obj = { ...candidateIn, evidence };
				const activeIn = fixture["activeForKey"] as Obj | null | undefined;
				const activeForKey =
					activeIn === undefined || activeIn === null
						? null
						: {
								itemId: "item:active",
								subject: candidate["subject"],
								kind: activeIn["kind"] ?? candidate["kind"],
								semanticKey: candidate["semanticKey"],
								status: "active",
								revision: 1,
								value: activeIn["value"],
								origin: activeIn["origin"] ?? "admitted_extraction",
								evidenceOrdinal: activeIn["evidenceOrdinal"],
							};
				const policyIn = (fixture["policy"] ?? {}) as Obj;
				const policy: Obj = {};
				for (const kind of KINDS) {
					policy[kind] = policyIn[kind] ?? policyIn["all"] ?? "user_confirm";
				}
				const decision = api.evaluateAdmission({
					candidate,
					principal: PRINCIPAL,
					scopeKey: SCOPE,
					inputSources: sources,
					currentSources,
					activeForKey,
					...(fixture["keyHistory"] === undefined
						? {}
						: { keyHistory: fixture["keyHistory"] }),
					policy,
				}) as Obj;
				const expected = fixture["expect"] as Obj;
				expect(decision["decision"]).toBe(expected["decision"]);
				expect(decision["reasonCode"]).toBe(expected["reasonCode"]);
				if (expected["effectiveKind"] !== undefined) {
					expect(api.effectiveCandidateKind(candidate)).toBe(
						expected["effectiveKind"],
					);
				}
			});
		}
	});
}
