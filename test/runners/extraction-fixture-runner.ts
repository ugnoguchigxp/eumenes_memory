/**
 * `fixtures/extraction/*.json`（Extraction の prepare → settle → confirm の実 SQLite fixture）の実行器。
 * 公開面（"eumenes-memory/sqlite"）の関数だけを使い、期待値は fixture に手書きされる（実装から導出しない）。
 *
 * 固定の前提: principal `local:owner`、scope `conversation:c1`（access.scopeKeys はこれだけ）、出典は
 * namespace `conversation` / kind `message` / representation `text`、id = `sources[].name`。
 *
 * fixture の形（fixtureFormat 1）:
 * - `sources[]`: `{ name, role, ordinal, content }`。ホストの現在の状態として runner が持つ（revision =
 *   `"sha256:" + 本文の UTF-8 の SHA-256 hex`、digest = その hex）。
 * - `steps[]` を順に実行する。`expect` は部分一致（書かれたキーだけ比べる）。
 *
 * step の `op`:
 * - `prepare`: `{ run, attempt?, sources?, enabled?, maxInputBytes?, expect }`。run は jobId（attempt 既定 1）。
 *   sources は名前の配列（既定は全部）。expect: `{ status, reasonCode?, sourceNames?, shown? }`
 *   （shown = 見せた state item のラベル）。
 * - `mutate`: `{ source, content?, status? }` ホストの現在の出典を書き換える（本文を変えると revision / digest が変わる）。
 * - `forget`: `{ source }` その出典を実の forget（planForget → applyForget、target host_source）で忘れる。閉包は実装どおり
 *   run / candidate / state item に届き、値が消える（S6）。
 * - `assert-state` / `edit-state` / `deactivate-state`: 既存の State 台帳を作る・変える。
 *   assert-state: `{ as, kind?, subject?, semanticKey, text, polarity?, source, quote, origin? }`（根拠は現在の本文中の quote）。
 *   edit-state: `{ item, text, source, quote, expectedRevision? }`。deactivate-state: `{ item, expectedRevision? }`。
 * - `settle`: `{ run, attempt?, output | outputRaw, policy?, withoutContent?, expect }`。output の evidence は
 *   `{ source: 名前, quote, locate?, range?: [start, end] }`（range 省略時は locate ?? quote の最初の出現の UTF-8 byte 範囲、
 *   sourceIndex は prepare した入力の添字）で、`{ sourceIndex, startByte, endByte, quote }` を直接書いてもよい。
 *   candidate の `replaces: "@<ラベル>"` は assert-state / confirm で付けたラベルの itemId に置き換わる。outputRaw はそのまま渡す。文字列 `{ "$repeat": [unit, times] }` と配列 `{ "$times": n, "item": {...} }`
 *   （item 内の文字列の `{i}` は 0 始まりの添字に置き換わる）で大きな出力を書ける。
 *   policy: `{ all?: mode, <kind>?: mode }`（既定は全 kind user_confirm。`all: auto_admit` は other_person_note には効かせない）。
 *   expect: `{ status, reasonCode?, admitted?, pendingUser?, rejected? }`。
 * - `list-candidates`: `{ decision?, expect: { count?, items?: [{ run, idx, decision, reasonCode, kind, subject, semanticKey, text, polarity, modality, temporal, evidence }] } }`
 *   （items は新しい順＝出力順の逆ではなく、返却順のまま。run は `jobId`、idx は出力内の添字）。
 * - `confirm`: `{ candidate: "<run>#<idx>", action, editedValue?, withoutContent?, sources?: "changed"|…, expect }`。
 *   現在の出典は runner が持つ状態から作る。expect: `{ status, reasonCode?, decision?, origin?, text?, polarity?, itemStatus?, as? }`。
 * - `list-state`: `{ includeInactive?, expect: { items: [{ semanticKey, status, origin, text, polarity }] } }`（順不同で比べる）。
 * - `check`: `{ run?: { id, stage, outcomeCode? }, progress?: { <source>: stage|null }, counts?: { candidate, state_item, run },
 *   edges?: { contains?: [...], exact?: [...] } }`（edge は `"<dependent>><dependency>:<role>"`）。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { AccessContext, SourceState } from "eumenes-memory";
import type { ExtractionInput, MemoryDb } from "eumenes-memory/sqlite";
import {
	applyForget,
	assertUserState,
	confirmCandidate,
	deactivateState,
	editState,
	listCandidates,
	listState,
	planForget,
	prepareExtraction,
	settleExtraction,
} from "eumenes-memory/sqlite";
import { loadFixtures } from "../fixture-runner.ts";
import { openTestStore } from "../support/store.ts";
import type { TestStore } from "../support/store.ts";

type Obj = Record<string, unknown>;

const PRINCIPAL = "local:owner";
const SCOPE = "conversation:c1";
const ACCESS: AccessContext = {
	principal: PRINCIPAL,
	scopeKeys: [SCOPE],
	purpose: "fixture",
	policyRevision: "1",
};
const KINDS = [
	"preference",
	"personal_fact",
	"constraint",
	"habit",
	"other_person_note",
] as const;

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteRange(content: string, needle: string): [number, number] {
	const index = content.indexOf(needle);
	if (index < 0) throw new Error(`text not found in source: ${needle}`);
	const start = Buffer.byteLength(content.slice(0, index), "utf8");
	return [start, start + Buffer.byteLength(needle, "utf8")];
}

interface HostSource {
	name: string;
	role: string;
	ordinal: number;
	content: string;
	status: string;
}

function sourceCore(source: HostSource): Obj {
	const digest = sha256(source.content);
	return {
		namespace: "conversation",
		kind: "message",
		id: source.name,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: PRINCIPAL,
		scopeKey: SCOPE,
		status: source.status,
	};
}

function sourceKeyOf(name: string): string {
	return JSON.stringify(["conversation", "message", name, "text"]);
}

/** `{ "$repeat": [...] }` と `{ "$times": n, "item": ... }` を展開する。 */
function expand(value: unknown, index?: number): unknown {
	if (Array.isArray(value)) return value.map((entry) => expand(entry, index));
	if (typeof value === "string") {
		return index === undefined ? value : value.replaceAll("{i}", String(index));
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Obj;
		if (Array.isArray(record["$repeat"])) {
			const [unit, times] = record["$repeat"] as [string, number];
			return unit.repeat(times);
		}
		if (typeof record["$times"] === "number") {
			return Array.from({ length: record["$times"] }, (_, i) =>
				expand(record["item"], i),
			);
		}
		return Object.fromEntries(
			Object.entries(record).map(([key, entry]) => [key, expand(entry, index)]),
		);
	}
	return value;
}

function policyOf(spec: Obj | undefined): Record<string, string> {
	const policy: Record<string, string> = {};
	for (const kind of KINDS) {
		const all = spec?.["all"];
		const fallback =
			all === "auto_admit" && kind === "other_person_note"
				? "user_confirm"
				: ((all as string | undefined) ?? "user_confirm");
		policy[kind] = (spec?.[kind] as string | undefined) ?? fallback;
	}
	return policy;
}

function pick(actual: unknown, expected: unknown, where: string): void {
	expect<unknown>({ where, actual }).toMatchObject({ where, actual: expected });
}

class Runner {
	readonly store: TestStore = openTestStore();
	readonly hostSources = new Map<string, HostSource>();
	readonly inputs = new Map<string, ExtractionInput>();
	readonly labels = new Map<string, string>(); // item label -> itemId
	readonly labelOf = new Map<string, string>(); // itemId -> label

	constructor(readonly fixture: Obj) {
		for (const source of fixture["sources"] as Obj[]) {
			this.hostSources.set(String(source["name"]), {
				name: String(source["name"]),
				role: String(source["role"] ?? "user"),
				ordinal: Number(source["ordinal"] ?? 0),
				content: String(source["content"]),
				status: "available",
			});
		}
	}

	close(): void {
		this.store.close();
	}

	runRef(step: Obj): { jobId: string; attempt: number } {
		return {
			jobId: String(step["run"]),
			attempt: Number(step["attempt"] ?? 1),
		};
	}

	runKey(step: Obj): string {
		const ref = this.runRef(step);
		return `${ref.jobId}:${ref.attempt}`;
	}

	source(name: string): HostSource {
		const source = this.hostSources.get(name);
		if (source === undefined) throw new Error(`unknown source ${name}`);
		return source;
	}

	currentSources(withoutContent: readonly string[] = []): SourceState[] {
		return [...this.hostSources.values()].map((source) => {
			const core = sourceCore(source);
			return (withoutContent.includes(source.name)
				? core
				: { ...core, content: source.content }) as unknown as SourceState;
		});
	}

	write<T>(op: (db: MemoryDb) => T): T {
		return this.store.write(op);
	}

	prepare(step: Obj, where: string): void {
		const names = (step["sources"] as string[] | undefined) ?? [
			...this.hostSources.keys(),
		];
		const sources = names.map((name) => {
			const source = this.source(name);
			return {
				...sourceCore(source),
				content: source.content,
				ordinal: source.ordinal,
				role: source.role,
			};
		});
		const result = this.write((db) =>
			prepareExtraction(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 1000 },
				run: this.runRef(step),
				enabled: step["enabled"] !== false,
				sources,
				profile: {
					extractorId: "fixture",
					promptVersion: "fixture-1",
					providerRef: "fixture-provider",
				},
				maxInputBytes: Number(step["maxInputBytes"] ?? 65536),
			} as never),
		);
		const expected = step["expect"] as Obj;
		expect<unknown>({ where, status: result.status }).toEqual({
			where,
			status: expected["status"] as never,
		});
		if (result.status === "ready") {
			this.inputs.set(this.runKey(step), result.input);
			if (expected["sourceNames"] !== undefined) {
				expect(result.input.sources.map((source) => source.ref.id)).toEqual(
					expected["sourceNames"] as string[],
				);
			}
			if (expected["shown"] !== undefined) {
				expect(
					result.input.shownState.map(
						(item) => this.labelOf.get(item.itemId) ?? item.itemId,
					),
				).toEqual(expected["shown"] as string[]);
			}
			expect(Object.isFrozen(result.input)).toBe(true);
		} else if (expected["reasonCode"] !== undefined) {
			expect<unknown>({
				where,
				reasonCode: (result as { reasonCode?: string }).reasonCode,
			}).toEqual({ where, reasonCode: expected["reasonCode"] as never });
		}
	}

	buildOutput(step: Obj): unknown {
		if (step["outputRaw"] !== undefined) return expand(step["outputRaw"]);
		const input = this.inputs.get(this.runKey(step));
		const output = expand(step["output"]) as Obj;
		const candidates = (output["candidates"] as Obj[]).map((candidate) => ({
			...candidate,
			...(typeof candidate["replaces"] === "string" &&
			candidate["replaces"].startsWith("@")
				? { replaces: this.labels.get(candidate["replaces"].slice(1)) }
				: {}),
			evidence: (candidate["evidence"] as Obj[]).map((evidence) => {
				if (typeof evidence["source"] !== "string") return evidence;
				const name = evidence["source"];
				const index = input?.sources.findIndex(
					(source) => source.ref.id === name,
				);
				const content = this.source(name).content;
				const range = Array.isArray(evidence["range"])
					? (evidence["range"] as [number, number])
					: byteRange(content, String(evidence["locate"] ?? evidence["quote"]));
				return {
					sourceIndex: index ?? -1,
					startByte: range[0],
					endByte: range[1],
					quote: evidence["quote"],
				};
			}),
		}));
		return { ...output, candidates };
	}

	settle(step: Obj, where: string): void {
		const output = this.buildOutput(step);
		const result = this.write((db) =>
			settleExtraction(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 2000 },
				run: this.runRef(step),
				output,
				currentSources: this.currentSources(
					step["withoutContent"] as string[] | undefined,
				),
				policy: policyOf(step["policy"] as Obj | undefined),
			} as never),
		);
		pick(result, step["expect"], where);
	}

	candidates(step: Obj, where: string): void {
		const result = this.store.read((db) =>
			listCandidates(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				...(step["decision"] === undefined
					? {}
					: { decision: step["decision"] as never }),
			}),
		);
		if (result.status !== "ok") throw new Error(`${where}: blocked`);
		const expected = step["expect"] as Obj;
		if (expected["count"] !== undefined) {
			expect<unknown>({ where, count: result.candidates.length }).toEqual({
				where,
				count: expected["count"] as never,
			});
		}
		if (expected["items"] !== undefined) {
			const items = result.candidates.map((candidate) => ({
				run: candidate.runId,
				idx: this.indexOf(candidate.candidateId, candidate.runId),
				decision: candidate.decision,
				reasonCode: candidate.reasonCode,
				kind: candidate.kind,
				subject: candidate.subject,
				semanticKey: candidate.semanticKey,
				text: candidate.value.text,
				polarity: candidate.value.polarity,
				modality: candidate.modality,
				temporal: candidate.temporal,
				evidence: candidate.evidence.length,
			}));
			expect<unknown>({ where, count: items.length }).toEqual({
				where,
				count: (expected["items"] as Obj[]).length,
			});
			for (const [index, item] of (expected["items"] as Obj[]).entries()) {
				const normalized: Obj = { ...item };
				if (typeof normalized["run"] === "string") {
					normalized["run"] = `${normalized["run"]}:1`;
				}
				pick(items[index], normalized, `${where} item ${index}`);
			}
		}
	}

	indexOf(candidateId: string, runId: string): number {
		const row = this.store.writer
			.query(
				"SELECT idx FROM memory_candidate WHERE candidate_id = ? AND run_id = ?",
			)
			.get(candidateId, runId) as { idx: number };
		return row.idx;
	}

	candidateId(spec: string): string {
		const [job, index] = spec.split("#");
		const row = this.store.writer
			.query(
				"SELECT candidate_id FROM memory_candidate WHERE run_id = ? AND idx = ?",
			)
			.get(`${job}:1`, Number(index)) as { candidate_id: string } | null;
		return row?.candidate_id ?? `cand:absent-${spec}`;
	}

	confirm(step: Obj, where: string): void {
		const result = this.write((db) =>
			confirmCandidate(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 3000 },
				candidateId: this.candidateId(String(step["candidate"])),
				action: step["action"] as never,
				...(step["editedValue"] === undefined
					? {}
					: { editedValue: step["editedValue"] as never }),
				currentSources: this.currentSources(
					step["withoutContent"] as string[] | undefined,
				),
			}),
		);
		const expected = step["expect"] as Obj;
		expect<unknown>({ where, status: result.status }).toEqual({
			where,
			status: expected["status"],
		});
		if (expected["reasonCode"] !== undefined) {
			expect<unknown>({
				where,
				reasonCode: (result as { reasonCode?: string }).reasonCode,
			}).toEqual({ where, reasonCode: expected["reasonCode"] });
		}
		if (expected["decision"] !== undefined) {
			expect<unknown>({
				where,
				decision: (result as { decision?: string }).decision,
			}).toEqual({ where, decision: expected["decision"] });
		}
		if (result.status === "admitted") {
			if (typeof expected["as"] === "string") {
				this.labels.set(expected["as"], result.item.itemId);
				this.labelOf.set(result.item.itemId, expected["as"]);
			}
			pick(
				{
					origin: result.item.origin,
					text: result.item.value.text,
					polarity: result.item.value.polarity,
					itemStatus: result.item.status,
				},
				Object.fromEntries(
					["origin", "text", "polarity", "itemStatus"]
						.filter((key) => expected[key] !== undefined)
						.map((key) => [key, expected[key]]),
				),
				where,
			);
		}
	}

	assertState(step: Obj, where: string): void {
		const source = this.source(String(step["source"]));
		const quote = String(step["quote"]);
		const range = byteRange(source.content, quote);
		const core = sourceCore(source);
		const evidence = [
			{
				source: {
					namespace: core["namespace"],
					kind: core["kind"],
					id: core["id"],
					representation: core["representation"],
					revision: core["revision"],
					digest: core["digest"],
					range: { startByte: range[0], endByte: range[1] },
				},
				quote,
			},
		];
		const result = this.write((db) =>
			assertUserState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 500 },
				kind: (step["kind"] as never) ?? "preference",
				subject: (step["subject"] as never) ?? "self",
				semanticKey: String(step["semanticKey"]),
				value: {
					text: String(step["text"]),
					polarity: (step["polarity"] as never) ?? "affirmed",
				},
				evidence,
				sources: [
					{ ...core, content: source.content, ordinal: source.ordinal },
				],
				origin: (step["origin"] as never) ?? "user_confirmed",
			} as never),
		);
		expect<unknown>({ where, status: result.status }).toEqual({
			where,
			status: "applied",
		});
		if (result.status === "applied") {
			this.labels.set(String(step["as"]), result.item.itemId);
			this.labelOf.set(result.item.itemId, String(step["as"]));
		}
	}

	editState(step: Obj, where: string): void {
		const source = this.source(String(step["source"]));
		const quote = String(step["quote"]);
		const range = byteRange(source.content, quote);
		const core = sourceCore(source);
		const itemId = this.labels.get(String(step["item"])) as string;
		const result = this.write((db) =>
			editState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 600 },
				itemId,
				expectedRevision: Number(step["expectedRevision"] ?? 1),
				value: {
					text: String(step["text"]),
					polarity: (step["polarity"] as never) ?? "affirmed",
				},
				evidence: [
					{
						source: {
							namespace: core["namespace"],
							kind: core["kind"],
							id: core["id"],
							representation: core["representation"],
							revision: core["revision"],
							digest: core["digest"],
							range: { startByte: range[0], endByte: range[1] },
						},
						quote,
					},
				],
				sources: [
					{ ...core, content: source.content, ordinal: source.ordinal },
				],
				origin: "user_edited",
			} as never),
		);
		expect<unknown>({ where, status: result.status }).toEqual({
			where,
			status: "applied",
		});
	}

	deactivateState(step: Obj, where: string): void {
		const itemId = this.labels.get(String(step["item"])) as string;
		const result = this.write((db) =>
			deactivateState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 700 },
				itemId,
				expectedRevision: Number(step["expectedRevision"] ?? 1),
			}),
		);
		expect<unknown>({ where, status: result.status }).toEqual({
			where,
			status: "applied",
		});
	}

	listState(step: Obj, where: string): void {
		const result = this.store.read((db) =>
			listState(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				includeInactive: step["includeInactive"] === true,
			}),
		);
		if (result.status !== "ok") throw new Error(`${where}: blocked`);
		const render = (item: Obj) =>
			`${item["semanticKey"]}|${item["status"]}|${item["origin"]}|${item["text"]}|${item["polarity"] ?? "affirmed"}`;
		const actual = result.items
			.map((item) =>
				render({
					semanticKey: item.semanticKey,
					status: item.status,
					origin: item.origin,
					text: item.value.text,
					polarity: item.value.polarity,
				}),
			)
			.sort();
		const expected = ((step["expect"] as Obj)["items"] as Obj[])
			.map(render)
			.sort();
		expect<unknown>({ where, items: actual }).toEqual({
			where,
			items: expected,
		});
	}

	check(step: Obj, where: string): void {
		const runSpec = step["run"] as Obj | undefined;
		if (runSpec !== undefined) {
			const row = this.store.writer
				.query(
					"SELECT stage, outcome_code FROM memory_extraction_run WHERE run_id = ?",
				)
				.get(`${String(runSpec["id"])}:1`) as Obj | null;
			pick(
				{
					stage: row?.["stage"] ?? null,
					outcomeCode: row?.["outcome_code"] ?? null,
				},
				{
					stage: runSpec["stage"],
					...(runSpec["outcomeCode"] === undefined
						? {}
						: { outcomeCode: runSpec["outcomeCode"] }),
				},
				`${where} run`,
			);
		}
		const progress = step["progress"] as Obj | undefined;
		if (progress !== undefined) {
			for (const [name, stage] of Object.entries(progress)) {
				const row = this.store.writer
					.query(
						"SELECT stage FROM memory_source_progress WHERE source_key = ?",
					)
					.get(sourceKeyOf(name)) as Obj | null;
				expect<unknown>({ where, name, stage: row?.["stage"] ?? null }).toEqual(
					{
						where,
						name,
						stage,
					},
				);
			}
		}
		const counts = step["counts"] as Obj | undefined;
		if (counts !== undefined) {
			const tables: Record<string, string> = {
				candidate: "memory_candidate",
				state_item: "memory_state_item",
				run: "memory_extraction_run",
				evidence: "memory_candidate_evidence",
			};
			for (const [name, n] of Object.entries(counts)) {
				const row = this.store.writer
					.query(`SELECT COUNT(*) AS n FROM ${tables[name] as string}`)
					.get() as { n: number };
				expect<unknown>({ where, name, n: row.n }).toEqual({ where, name, n });
			}
		}
		const edges = step["edges"] as Obj | undefined;
		if (edges !== undefined) {
			const actual = (
				this.store.writer
					.query(
						"SELECT dependent_type, dependency_type, role FROM memory_dependency",
					)
					.all() as Obj[]
			).map(
				(row) =>
					`${row["dependent_type"]}>${row["dependency_type"]}:${row["role"]}`,
			);
			for (const wanted of (edges["contains"] as string[] | undefined) ?? []) {
				expect<unknown>({
					where,
					wanted,
					found: actual.includes(wanted),
				}).toEqual({
					where,
					wanted,
					found: true,
				});
			}
			if (edges["exact"] !== undefined) {
				expect<unknown>({ where, edges: [...new Set(actual)].sort() }).toEqual({
					where,
					edges: [...new Set(edges["exact"] as string[])].sort(),
				});
			}
		}
	}

	forget(step: Obj, where: string): void {
		const planned = this.store.read((db) =>
			planForget(db, {
				contractVersion: 1,
				access: ACCESS,
				target: {
					type: "host_source",
					sourceKey: sourceKeyOf(String(step["source"])),
					scopeKey: SCOPE,
				},
				clock: { atMs: 1000 },
			}),
		);
		if (planned.status !== "planned") {
			throw new Error(`${where}: forget blocked`);
		}
		this.store.write((db) =>
			applyForget(db, {
				contractVersion: 1,
				entry: planned.plan.entry,
				clock: { atMs: 1000 },
			}),
		);
	}

	step(step: Obj, where: string): void {
		switch (step["op"]) {
			case "prepare":
				return this.prepare(step, where);
			case "mutate": {
				const source = this.source(String(step["source"]));
				if (typeof step["content"] === "string")
					source.content = step["content"];
				if (typeof step["status"] === "string") source.status = step["status"];
				return;
			}
			case "forget":
				return this.forget(step, where);
			case "assert-state":
				return this.assertState(step, where);
			case "edit-state":
				return this.editState(step, where);
			case "deactivate-state":
				return this.deactivateState(step, where);
			case "settle":
				return this.settle(step, where);
			case "list-candidates":
				return this.candidates(step, where);
			case "confirm":
				return this.confirm(step, where);
			case "list-state":
				return this.listState(step, where);
			case "check":
				return this.check(step, where);
			default:
				throw new Error(`${where}: unknown op ${String(step["op"])}`);
		}
	}
}

export function describeExtractionFixtures(): void {
	describe("extraction fixtures (real SQLite)", () => {
		for (const fixture of loadFixtures("extraction")) {
			test(String(fixture["id"]), () => {
				const runner = new Runner(fixture);
				try {
					for (const [index, step] of (fixture["steps"] as Obj[]).entries()) {
						runner.step(
							step,
							`${String(fixture["id"])} step ${index} (${String(step["op"])})`,
						);
					}
				} finally {
					runner.close();
				}
			});
		}
	});
}
