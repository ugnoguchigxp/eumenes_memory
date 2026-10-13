/**
 * 忘却の閉包テスト用: 宣言的な依存グラフ（GraphSpec）から実 SQLite の Memory DB を組み立て、
 * 実装とは独立の oracle（素朴な BFS）で「forget 後に忘れられているはずの集合」を求める。
 *
 * 行は SQL で直接書く（State の公開 API は本文と quote の検査を伴うため、グラフ形状を自由に
 * 作れない）。外部派生物の登録は公開 API（registerExternalDependents）を使う。値は行ごとに一意の
 * `SECRET-…` 文字列にして、forget 後に memory_ 表のどこにも残らないことを検査できるようにする。
 *
 * 参照の書き方: `m:<name>` = 会話の出典（host_source）、`r:<name>` = Records の record、`i:<id>` = state item。
 */
import { createHash } from "node:crypto";
import {
	captureRecord,
	registerExternalDependents,
} from "eumenes-memory/sqlite";
import type { MemoryDb } from "eumenes-memory/sqlite";
import type { AccessContext } from "eumenes-memory";
import type { TestStore } from "../support/store.ts";

export const PRINCIPAL = "local:owner";
export const SCOPE = "scope:a";
export const OTHER_SCOPE = "scope:b";
export const ACCESS: AccessContext = {
	principal: PRINCIPAL,
	scopeKeys: [SCOPE, OTHER_SCOPE],
	purpose: "test",
	policyRevision: "1",
};

export interface ItemSpec {
	readonly id: string;
	readonly scope?: string;
	/** 根拠の出典参照（`m:` / `r:`）。先頭が primary、残りが support。 */
	readonly evidence: readonly string[];
}
export interface ExternalSpec {
	/** `<providerRef>:<externalId>`。 */
	readonly id: string;
	/** `m:` / `r:` / `i:` の参照。 */
	readonly dependsOn: readonly string[];
	readonly scope?: string;
}
export interface GraphSpec {
	readonly records?: readonly string[];
	readonly items?: readonly ItemSpec[];
	readonly externals?: readonly ExternalSpec[];
}

export type ForgetTargetSpec =
	| { readonly type: "host_source"; readonly source: string }
	| { readonly type: "record"; readonly name: string }
	| { readonly type: "state_item"; readonly id: string }
	| { readonly type: "scope"; readonly scope: string };

export function messageKey(name: string): string {
	return JSON.stringify(["conversation", "message", name, "text"]);
}

export const DERIVED_TYPES = ["state_item", "external"] as const;
export type DerivedType = (typeof DERIVED_TYPES)[number];

export interface BuiltGraph {
	readonly spec: GraphSpec;
	readonly recordIds: ReadonlyMap<string, string>;
	/** 参照 → SourceKey（`m:` と `r:`）。 */
	sourceKeyOf(ref: string): string;
	/** 値を持つ行の secret 文字列（id → secrets）。 */
	readonly secrets: ReadonlyMap<string, readonly string[]>;
}

export function nextSeq(db: MemoryDb): number {
	const row = db
		.query(
			"UPDATE memory_seq SET value = value + 1 WHERE id = 1 RETURNING value",
		)
		.get() as { value: number };
	return row.value;
}

function digestOf(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function insertEdge(
	db: MemoryDb,
	scope: string,
	dependentType: string,
	dependentId: string,
	dependencyType: string,
	dependencyId: string,
	role: string,
): void {
	db.query(
		`INSERT INTO memory_dependency
			(principal, scope_key, dependent_type, dependent_id, dependency_type, dependency_id, role)
		VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
	).run(
		PRINCIPAL,
		scope,
		dependentType,
		dependentId,
		dependencyType,
		dependencyId,
		role,
	);
}

/** グラフを DB に書く（`store.write` を内部で使う）。 */
export function buildGraph(store: TestStore, spec: GraphSpec): BuiltGraph {
	const recordIds = new Map<string, string>();
	const secrets = new Map<string, string[]>();
	const addSecret = (id: string, secret: string): string => {
		const list = secrets.get(id) ?? [];
		list.push(secret);
		secrets.set(id, list);
		return secret;
	};
	for (const name of spec.records ?? []) {
		const secret = addSecret(`r:${name}`, `SECRET-rec-${name}`);
		const result = store.write((db) =>
			captureRecord(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: 1 },
				origin: { namespace: "web", kind: "page", id: name },
				mediaType: "text/plain",
				content: `${secret} body`,
				captureState: "complete",
			}),
		);
		if (result.status !== "captured") throw new Error("capture blocked");
		recordIds.set(name, result.recordId);
	}
	const sourceKeyOf = (ref: string): string => {
		if (ref.startsWith("m:")) return messageKey(ref.slice(2));
		if (ref.startsWith("r:")) {
			const recordId = recordIds.get(ref.slice(2));
			if (recordId === undefined) throw new Error(`unknown record ${ref}`);
			return JSON.stringify(["memory", "record", recordId, "text"]);
		}
		throw new Error(`not a source ref: ${ref}`);
	};
	const sourceParts = (ref: string) => {
		const key = sourceKeyOf(ref);
		const [namespace, kind, id, representation] = JSON.parse(key) as string[];
		return { key, namespace, kind, id, representation } as {
			key: string;
			namespace: string;
			kind: string;
			id: string;
			representation: string;
		};
	};

	store.write((db) => {
		for (const item of spec.items ?? []) {
			const scope = item.scope ?? SCOPE;
			const value = addSecret(`i:${item.id}`, `SECRET-item-${item.id}`);
			const attr = addSecret(`i:${item.id}`, `SECRET-attr-${item.id}`);
			const seq = nextSeq(db);
			db.query(
				`INSERT INTO memory_state_item
					(item_id, principal, scope_key, subject, kind, semantic_key, status, revision, value_text,
					 polarity, origin, evidence_ordinal, valid_from_ms, valid_until_ms, created_seq, updated_seq)
				VALUES (?, ?, ?, 'self', 'preference', ?, 'active', 1, ?, 'affirmed', 'user_confirmed', 1, 5, 9, ?, ?)`,
			).run(item.id, PRINCIPAL, scope, `key-${item.id}`, value, seq, seq);
			db.query(
				"INSERT INTO memory_state_attribute (item_id, attr_key, attr_value) VALUES (?, 'k', ?)",
			).run(item.id, attr);
			for (const [idx, ref] of item.evidence.entries()) {
				const parts = sourceParts(ref);
				db.query(
					`INSERT INTO memory_state_evidence
						(item_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, start_byte, end_byte)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 3)`,
				).run(
					item.id,
					idx,
					parts.key,
					parts.namespace,
					parts.kind,
					parts.id,
					parts.representation,
					`sha256:${digestOf(`rev-${ref}`)}`,
					digestOf(`dig-${ref}`),
				);
				insertEdge(
					db,
					scope,
					"state_item",
					item.id,
					"source",
					parts.key,
					idx === 0 ? "primary" : "support",
				);
			}
			db.query(
				`INSERT INTO memory_state_event
					(event_seq, item_id, principal, scope_key, action, from_revision, to_revision, cause_type, cause_id, at_ms)
				VALUES (?, ?, ?, ?, 'assert', NULL, 1, ?, ?, 7)`,
			).run(nextSeq(db), item.id, PRINCIPAL, scope, "user", PRINCIPAL);
		}
	});

	for (const external of spec.externals ?? []) {
		const colon = external.id.indexOf(":");
		const result = store.write((db) =>
			registerExternalDependents(db, {
				contractVersion: 1,
				access: ACCESS,
				scopeKey: external.scope ?? SCOPE,
				clock: { atMs: 1 },
				dependents: [
					{
						providerRef: external.id.slice(0, colon),
						externalId: external.id.slice(colon + 1),
						dependsOn: external.dependsOn.map((ref) =>
							ref.startsWith("i:")
								? { type: "state_item" as const, id: ref.slice(2) }
								: { type: "source" as const, id: sourceKeyOf(ref) },
						),
					},
				],
			}),
		);
		if (result.status !== "registered") {
			throw new Error(`register ${external.id}: ${JSON.stringify(result)}`);
		}
	}
	return { spec, recordIds, sourceKeyOf, secrets };
}

export function toForgetTarget(graph: BuiltGraph, target: ForgetTargetSpec) {
	switch (target.type) {
		case "host_source":
			return {
				type: "host_source" as const,
				sourceKey: graph.sourceKeyOf(target.source),
				scopeKey: SCOPE,
			};
		case "record":
			return {
				type: "record" as const,
				recordId: graph.recordIds.get(target.name) as string,
				scopeKey: SCOPE,
			};
		case "state_item": {
			const item = (graph.spec.items ?? []).find(
				(entry) => entry.id === target.id,
			);
			return {
				type: "state_item" as const,
				itemId: target.id,
				scopeKey: item?.scope ?? SCOPE,
			};
		}
		case "scope":
			return { type: "scope" as const, scopeKey: target.scope };
	}
}

// ---- oracle ----

export interface Expected {
	readonly state_item: ReadonlySet<string>;
	readonly external: ReadonlySet<string>;
	/** 墓標 `source` が書かれる出典キー（record の出典を含む）。 */
	readonly sources: ReadonlySet<string>;
	readonly records: ReadonlySet<string>;
}

interface Node {
	readonly type: string;
	readonly id: string;
}

/** 実装とは別に、spec から素朴に BFS して閉包を求める。 */
export function expectedForgotten(
	graph: BuiltGraph,
	targets: readonly ForgetTargetSpec[],
): Expected {
	// forget は順に適用される。scope の forget が出典に墓標を付けるか（他 scope がまだ引用しているか）は、
	// それまでに忘れた行を除いて判定する。
	const forgotten = new Set<string>();
	const sources = new Set<string>();
	const records = new Set<string>();
	for (const target of targets) {
		const one = expectedOne(graph, target, forgotten);
		for (const type of DERIVED_TYPES) {
			for (const id of one[type]) forgotten.add(`${type}|${id}`);
		}
		for (const key of one.sources) sources.add(key);
		for (const name of one.records) records.add(name);
	}
	const pick = (type: string) =>
		new Set(
			[...forgotten]
				.filter((entry) => entry.startsWith(`${type}|`))
				.map((entry) => entry.slice(type.length + 1)),
		);
	return {
		state_item: pick("state_item"),
		external: pick("external"),
		sources,
		records,
	};
}

function expectedOne(
	graph: BuiltGraph,
	target: ForgetTargetSpec,
	alreadyForgotten: ReadonlySet<string>,
): Expected {
	const targets = [target];
	const spec = graph.spec;
	const dependents = new Map<string, Node[]>();
	const key = (type: string, id: string) => `${type}|${id}`;
	const link = (from: Node, to: Node) => {
		// from (dependent) が to (dependency) に依存する。
		const list = dependents.get(key(to.type, to.id)) ?? [];
		list.push(from);
		dependents.set(key(to.type, to.id), list);
	};
	const src = (ref: string): Node => ({
		type: "source",
		id: graph.sourceKeyOf(ref),
	});
	for (const item of spec.items ?? []) {
		for (const ref of item.evidence)
			link({ type: "state_item", id: item.id }, src(ref));
	}
	for (const external of spec.externals ?? []) {
		for (const ref of external.dependsOn) {
			link(
				{ type: "external", id: external.id },
				ref.startsWith("i:")
					? { type: "state_item", id: ref.slice(2) }
					: src(ref),
			);
		}
	}
	const starts: Node[] = [];
	const sources = new Set<string>();
	const records = new Set<string>();
	for (const target of targets) {
		if (target.type === "host_source") {
			const sourceKey = graph.sourceKeyOf(target.source);
			if (target.source.startsWith("r:")) {
				records.add(target.source.slice(2));
			}
			sources.add(sourceKey);
			starts.push({ type: "source", id: sourceKey });
		} else if (target.type === "record") {
			records.add(target.name);
			const sourceKey = graph.sourceKeyOf(`r:${target.name}`);
			sources.add(sourceKey);
			starts.push({ type: "source", id: sourceKey });
		} else if (target.type === "state_item") {
			starts.push({ type: "state_item", id: target.id });
		} else {
			const inScope = (scope: string | undefined) =>
				(scope ?? SCOPE) === target.scope;
			// scope 内の派生行が引用する host の出典のうち、他の scope の派生行が引用していないものだけ墓標にする。
			// 引用していた行が既に忘れられていても、その scope の出典として数える（辺は残る）が、
			// 他の scope が引用しているかは、まだ忘れていない行だけで判定する。
			const citedByScope = new Map<string, Set<string>>();
			const liveCitedByScope = new Map<string, Set<string>>();
			const cite = (
				scope: string | undefined,
				refs: readonly string[],
				dependent: string,
			) => {
				for (const ref of refs) {
					if (!ref.startsWith("m:")) continue;
					const key = graph.sourceKeyOf(ref);
					const all = citedByScope.get(key) ?? new Set<string>();
					all.add(scope ?? SCOPE);
					citedByScope.set(key, all);
					if (alreadyForgotten.has(dependent)) continue;
					const live = liveCitedByScope.get(key) ?? new Set<string>();
					live.add(scope ?? SCOPE);
					liveCitedByScope.set(key, live);
				}
			};
			for (const item of spec.items ?? []) {
				cite(item.scope, item.evidence, `state_item|${item.id}`);
			}
			for (const external of spec.externals ?? []) {
				cite(external.scope, external.dependsOn, `external|${external.id}`);
			}
			for (const [key, scopes] of citedByScope) {
				const others = [...(liveCitedByScope.get(key) ?? [])].filter(
					(scope) => scope !== target.scope,
				);
				if (scopes.has(target.scope) && others.length === 0) sources.add(key);
			}
			for (const name of spec.records ?? []) {
				if (target.scope === SCOPE) {
					records.add(name);
					const sourceKey = graph.sourceKeyOf(`r:${name}`);
					sources.add(sourceKey);
					starts.push({ type: "source", id: sourceKey });
				}
			}
			for (const item of spec.items ?? []) {
				if (inScope(item.scope))
					starts.push({ type: "state_item", id: item.id });
			}
			for (const external of spec.externals ?? []) {
				if (inScope(external.scope)) {
					starts.push({ type: "external", id: external.id });
				}
			}
		}
	}
	const seen = new Set<string>();
	const queue = [...starts];
	for (const start of starts) seen.add(key(start.type, start.id));
	for (let i = 0; i < queue.length; i += 1) {
		const node = queue[i] as Node;
		for (const next of dependents.get(key(node.type, node.id)) ?? []) {
			const k = key(next.type, next.id);
			if (seen.has(k)) continue;
			seen.add(k);
			queue.push(next);
		}
	}
	const pick = (type: string) =>
		new Set(
			[...seen]
				.filter((entry) => entry.startsWith(`${type}|`))
				.map((entry) => entry.slice(type.length + 1)),
		);
	return {
		state_item: pick("state_item"),
		external: pick("external"),
		sources,
		records,
	};
}

// ---- 観測 ----

/** 派生行（state_item と付随表）の行を ID ごとの文字列にする（閉包外の不変検査用）。 */
export function derivedRowsById(store: TestStore): Map<string, string> {
	const out = new Map<string, string>();
	const grab = (type: string, id: string, sql: string, ...params: string[]) => {
		out.set(
			`${type}|${id}`,
			JSON.stringify(store.writer.query(sql).all(...params)),
		);
	};
	for (const row of store.writer
		.query("SELECT item_id FROM memory_state_item")
		.all() as { item_id: string }[]) {
		const id = row.item_id;
		grab(
			"state_item",
			id,
			"SELECT * FROM memory_state_item WHERE item_id = ?",
			id,
		);
		grab(
			"state_item.attr",
			id,
			"SELECT * FROM memory_state_attribute WHERE item_id = ?",
			id,
		);
		grab(
			"state_item.evidence",
			id,
			"SELECT * FROM memory_state_evidence WHERE item_id = ?",
			id,
		);
		grab(
			"state_item.event",
			id,
			"SELECT * FROM memory_state_event WHERE item_id = ?",
			id,
		);
	}
	return out;
}

export function tombstoneSet(store: TestStore, type: string): Set<string> {
	return new Set(
		(
			store.writer
				.query("SELECT target_id FROM memory_tombstone WHERE target_type = ?")
				.all(type) as { target_id: string }[]
		).map((row) => row.target_id),
	);
}

/** 閉包の不変条件: 依存辺で dependency が忘却済みなら dependent も忘却済み（墓標あり）。違反した辺を返す。 */
export function closureViolations(store: TestStore): string[] {
	const tombstoned = new Set(
		(
			store.writer
				.query("SELECT target_type, target_id FROM memory_tombstone")
				.all() as { target_type: string; target_id: string }[]
		).map((row) => `${row.target_type}|${row.target_id}`),
	);
	const bad: string[] = [];
	for (const edge of store.writer
		.query(
			"SELECT dependent_type, dependent_id, dependency_type, dependency_id FROM memory_dependency",
		)
		.all() as Record<string, string>[]) {
		const dependency = `${edge["dependency_type"]}|${edge["dependency_id"]}`;
		const dependent = `${edge["dependent_type"]}|${edge["dependent_id"]}`;
		if (tombstoned.has(dependency) && !tombstoned.has(dependent)) {
			bad.push(`${dependent} <- ${dependency}`);
		}
	}
	return bad;
}

/** 固定 seed の決定的 PRNG（mulberry32）。 */
export function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
