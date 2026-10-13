/**
 * Lifecycle / Forget と ExternalDependent 登録の永続 API。契約は `src/domains/lifecycle/contracts/index.ts` と
 * `src/contracts/external.ts`。
 *
 * planForget / applyForget / reconcileForgetJournal / getForgetReceipt は target `record` / `host_source` /
 * `state_item` / `scope` を扱う。`enabled`（Memory ON/OFF）に依存しない。
 *
 * 閉包: 起点（出典キー、または state_item / external の node）から `memory_dependency` を
 * 再帰 CTE で辿った辺を、純粋な `computeClosure` に渡して求める。起点が次のとおり。
 * - record: その record の出典キー。host_source: その出典キー。
 * - state_item: その item。
 * - scope: scope の record の出典キー、scope の state_item / external（辺の scope_key が scope のもの）。
 *   scope が引用している record 以外の出典は、墓標だけ書く（以後その出典から採用しない）。
 * 閉包内の各行は apply で値を消す（state_item は `scrubStateItem`）うえで墓標を書く。外部派生物（`external` 辺）と、
 * 外部へ送った record の `providerRef` は `memory_forget_external` に `pending` で登録する。
 *
 * 限界: 物理消去（空き領域・WAL・OS のスナップショット）は保証しない。外部の確認状況は DB の中にだけあり、
 * 古い DB を復元して reconcile すると外部削除は `pending` に戻る（ホストが `recordExternalDeletion` をやり直す）。
 */
import { canonicalJson } from "../../../canonical/json.ts";
import {
	DEPENDENCY_ROLES,
	DEPENDENT_NODE_TYPES,
	DEPENDENCY_NODE_TYPES,
	EXTERNAL_DELETION_STATES,
} from "../contracts/index.ts";
import type {
	ApplyForgetInput,
	ClosureEdge,
	ClosureNodeRef,
	ExternalDeletion,
	ExternalDeletionState,
	ForgetExternalState,
	ForgetJournalEntry,
	ForgetJournalTarget,
	ForgetPlan,
	ForgetReceipt,
	GetForgetReceiptInput,
	GetForgetReceiptResult,
	PlanForgetInput,
	PlanForgetResult,
	RecordExternalDeletionInput,
	RecordExternalDeletionResult,
	ReconcileForgetJournalInput,
	ReconcileForgetJournalResult,
	TombstoneTargetType,
} from "../contracts/index.ts";
import type {
	RegisterExternalDependentsInput,
	RegisterExternalDependentsResult,
	UnregisterExternalDependentsInput,
	UnregisterExternalDependentsResult,
} from "../../../contracts/external.ts";
import { isRecordId, recordSourceKey } from "../../records/index.ts";
import { computeClosure } from "../service/closure.ts";
import type { Closure } from "../service/closure.ts";
import {
	parseRecordExternalDeletionInput,
	parseRegisterExternalDependentsInput,
	parseUnregisterExternalDependentsInput,
} from "../service/external-parse.ts";
import {
	buildJournalEntry,
	isSelfConsistent,
	verifyForgetJournal,
} from "../service/journal.ts";
import {
	parseApplyForgetInput,
	parseGetForgetReceiptInput,
	parsePlanForgetInput,
	parseReconcileForgetJournalInput,
} from "../service/parse.ts";
import { recordIdOfSourceKey } from "../service/targets.ts";
import { appendMemoryChange } from "../../../infrastructure/sqlite/changes.ts";
import { addDependency } from "../../../infrastructure/sqlite/dependency.ts";
import {
	guarded,
	readInteger,
	readRow,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb, SqlValue } from "../../../infrastructure/sqlite/db.ts";
import { MemoryStoreError } from "../../../infrastructure/sqlite/errors.ts";
import { ownValue } from "../../../contracts/own.ts";
import {
	listRecordIdsInScope,
	listRecordProviders,
	recordIsLive,
	recordOwnership,
	scrubRecord,
} from "../../records/sqlite.ts";
import {
	enterRead,
	enterWrite,
} from "../../../infrastructure/sqlite/session.ts";
import {
	listStateItemIdsInScope,
	scrubStateItem,
	stateItemScope,
} from "../../state/sqlite.ts";
import { isTombstoned } from "../../../infrastructure/sqlite/tombstone.ts";

// ---- ジャーナル head ----

interface JournalHead {
	readonly seq: number;
	readonly hash: string;
}

function readJournalHead(db: MemoryDb): JournalHead {
	const row = guarded(() =>
		db
			.query(
				"SELECT applied_head_seq, applied_head_hash FROM memory_journal_state WHERE id = 1",
			)
			.get(),
	);
	if (row === null || row === undefined) {
		throw new MemoryStoreError("CORRUPT_ROW");
	}
	return {
		seq: readInteger(row, "applied_head_seq"),
		hash: readText(row, "applied_head_hash"),
	};
}

// ---- 閉包の収集 ----

const CLOSURE_CHUNK = 200;

interface CollectedClosure {
	readonly closure: Closure;
	/** 閉包内の node（`type\0id`）→ その辺が属する scope。 */
	readonly scopeOf: ReadonlyMap<string, string>;
}

function nodeKey(type: string, id: string): string {
	return `${type}\u0000${id}`;
}

function pick<T extends string>(value: string, allowed: readonly T[]): T {
	const found = allowed.find((candidate) => candidate === value);
	if (found === undefined) throw new MemoryStoreError("CORRUPT_ROW");
	return found;
}

/**
 * 起点の node から `memory_dependency` を dependency → dependent 方向に再帰 CTE で辿り、
 * （`reach` を外側、辺の表を `memory_dependency_by_dependency` で引く順に固定する。固定しないと
 * 辺の表の全走査が reach の行数ぶん繰り返されて二乗になる。）
 * 到達できる辺を集めて純粋な `computeClosure` に渡す。全表をロードしない。
 */
function collectClosure(
	db: MemoryDb,
	principal: string,
	starts: readonly ClosureNodeRef[],
): CollectedClosure {
	const edges = new Map<string, ClosureEdge>();
	const scopeOf = new Map<string, string>();
	for (let offset = 0; offset < starts.length; offset += CLOSURE_CHUNK) {
		const chunk = starts.slice(offset, offset + CLOSURE_CHUNK);
		const values = chunk.map(() => "(?, ?)").join(", ");
		const params: SqlValue[] = [];
		for (const start of chunk) params.push(start.type, start.id);
		const rows = guarded(() =>
			db
				.query(
					`WITH RECURSIVE reach(type, id) AS (
						SELECT column1, column2 FROM (VALUES ${values})
						UNION
						SELECT d.dependent_type, d.dependent_id
						FROM reach r
						CROSS JOIN memory_dependency d INDEXED BY memory_dependency_by_dependency
							ON d.dependency_type = r.type AND d.dependency_id = r.id
						WHERE d.principal = ?
					)
					SELECT d.scope_key AS scope_key, d.dependent_type AS dependent_type,
						d.dependent_id AS dependent_id, d.dependency_type AS dependency_type,
						d.dependency_id AS dependency_id, d.role AS role
					FROM reach r
					CROSS JOIN memory_dependency d INDEXED BY memory_dependency_by_dependency
						ON d.dependency_type = r.type AND d.dependency_id = r.id
					WHERE d.principal = ?`,
				)
				.all(...params, principal, principal),
		);
		for (const row of rows) {
			const record = readRow(row);
			const edge: ClosureEdge = {
				dependentType: pick(
					readText(record, "dependent_type"),
					DEPENDENT_NODE_TYPES,
				),
				dependentId: readText(record, "dependent_id"),
				dependencyType: pick(
					readText(record, "dependency_type"),
					DEPENDENCY_NODE_TYPES,
				),
				dependencyId: readText(record, "dependency_id"),
				role: pick(readText(record, "role"), DEPENDENCY_ROLES),
			};
			edges.set(
				`${nodeKey(edge.dependentType, edge.dependentId)}\u0001${nodeKey(
					edge.dependencyType,
					edge.dependencyId,
				)}\u0001${edge.role}`,
				edge,
			);
			scopeOf.set(
				nodeKey(edge.dependentType, edge.dependentId),
				readText(record, "scope_key"),
			);
		}
	}
	return { closure: computeClosure([...edges.values()], starts), scopeOf };
}

function splitExternalNodeId(id: string): {
	readonly providerRef: string;
	readonly externalId: string;
} {
	const colon = id.indexOf(":");
	if (colon <= 0) throw new MemoryStoreError("CORRUPT_ROW");
	return { providerRef: id.slice(0, colon), externalId: id.slice(colon + 1) };
}

// ---- forget の対象集合 ----

type DerivedNodeType = "state_item" | "external";

interface DerivedNode {
	readonly type: DerivedNodeType;
	readonly id: string;
	/** 辺または対象から分かる scope（行があれば apply で行の scope を優先する）。 */
	readonly scopeKey: string;
}

interface RecordRef {
	readonly recordId: string;
	readonly scopeKey: string;
}

interface SourceRefToTombstone {
	readonly sourceKey: string;
	readonly scopeKey: string;
}

interface ForgetSet {
	readonly records: readonly RecordRef[];
	/** record 以外の出典（host_source と、scope が引用している出典）。墓標 `source` を書く。 */
	readonly sources: readonly SourceRefToTombstone[];
	/** 起点の派生行 + 閉包に入る派生行（重複なし、型 → id の順）。 */
	readonly nodes: readonly DerivedNode[];
}

function isDerivedType(type: string): type is DerivedNodeType {
	return type === "state_item" || type === "external";
}

function queryIds(
	db: MemoryDb,
	sql: string,
	params: readonly SqlValue[],
	column: string,
): string[] {
	return guarded(() => db.query(sql).all(...params)).map((row) =>
		readText(row, column),
	);
}

/**
 * entry の targets から、record / 出典 / 派生行の集合を求める。`createdBefore` が非 null（適用済み entry の再適用）
 * のとき、scope target は最初の適用より前に作られた行だけを対象にし、その forget が書いた墓標の行は
 * 必ず含める（後から作られた行を消さない）。
 */
function resolveForgetSet(
	db: MemoryDb,
	principal: string,
	entry: ForgetJournalEntry,
	createdBefore: number | null,
): ForgetSet {
	const records = new Map<string, RecordRef>();
	const sources = new Map<string, SourceRefToTombstone>();
	const starts = new Map<string, DerivedNode>();
	const closureStarts: ClosureNodeRef[] = [];

	const addStart = (node: DerivedNode): void => {
		starts.set(nodeKey(node.type, node.id), node);
	};

	for (const target of entry.targets) {
		switch (target.type) {
			case "record":
				records.set(target.id, {
					recordId: target.id,
					scopeKey: target.scopeKey,
				});
				break;
			case "host_source": {
				const recordId = recordIdOfSourceKey(target.id);
				if (
					recordId !== null &&
					recordOwnership(db, principal, target.scopeKey, recordId) === "owned"
				) {
					records.set(recordId, { recordId, scopeKey: target.scopeKey });
				} else {
					sources.set(target.id, {
						sourceKey: target.id,
						scopeKey: target.scopeKey,
					});
					closureStarts.push({ type: "source", id: target.id });
				}
				break;
			}
			case "state_item": {
				addStart({
					type: "state_item",
					id: target.id,
					scopeKey: target.scopeKey,
				});
				break;
			}
			case "scope": {
				for (const recordId of listRecordIdsInScope(
					db,
					principal,
					target.scopeKey,
					createdBefore,
				)) {
					records.set(recordId, { recordId, scopeKey: target.scopeKey });
				}
				for (const id of listStateItemIdsInScope(
					db,
					principal,
					target.scopeKey,
					createdBefore,
				)) {
					addStart({ type: "state_item", id, scopeKey: target.scopeKey });
				}
				// 外部派生物（辺に作成 seq がないため、再適用ではその forget が墓標を書いた分だけ）。
				if (createdBefore === null) {
					for (const id of queryIds(
						db,
						`SELECT DISTINCT dependent_id FROM memory_dependency
						WHERE principal = ? AND scope_key = ? AND dependent_type = 'external'`,
						[principal, target.scopeKey],
						"dependent_id",
					)) {
						addStart({ type: "external", id, scopeKey: target.scopeKey });
					}
				}
				// scope が引用する host の出典のうち、他の scope の派生行が引用していないものは墓標だけ書く
				// （以後その出典から採用しない）。他の scope が（まだ忘れていない行で）引用する出典は触らない（巻き込まない）。
				// 再適用では、最初の適用が書いた墓標だけを対象にする（下の createdBefore の節）。
				if (createdBefore === null) {
					for (const sourceKey of queryIds(
						db,
						`SELECT DISTINCT d.dependency_id FROM memory_dependency d
						WHERE d.principal = ? AND d.scope_key = ? AND d.dependency_type = 'source'
							AND NOT EXISTS (
								SELECT 1 FROM memory_dependency o
								WHERE o.principal = d.principal AND o.dependency_type = 'source'
									AND o.dependency_id = d.dependency_id AND o.scope_key <> d.scope_key
									AND NOT EXISTS (
										SELECT 1 FROM memory_tombstone t
										WHERE t.target_type = o.dependent_type AND t.target_id = o.dependent_id
									)
							)`,
						[principal, target.scopeKey],
						"dependency_id",
					)) {
						// record の出典は scope 内の record として扱う（他 scope の record を巻き込まない）。
						if (recordIdOfSourceKey(sourceKey) !== null) continue;
						sources.set(sourceKey, { sourceKey, scopeKey: target.scopeKey });
					}
				}
				break;
			}
		}
	}
	if (createdBefore !== null) {
		// 再適用: この forget が書いた墓標の行は必ず再び消す。
		for (const row of guarded(() =>
			db
				.query(
					`SELECT target_type, target_id, scope_key FROM memory_tombstone
					WHERE forget_id = ? AND principal = ?`,
				)
				.all(entry.forgetId, principal),
		)) {
			const type = readText(row, "target_type");
			const id = readText(row, "target_id");
			const scopeKey = readText(row, "scope_key");
			if (isDerivedType(type)) addStart({ type, id, scopeKey });
			else if (type === "source" && recordIdOfSourceKey(id) === null) {
				sources.set(id, { sourceKey: id, scopeKey });
			}
		}
	}

	for (const ref of records.values()) {
		closureStarts.push({ type: "source", id: recordSourceKey(ref.recordId) });
	}
	for (const node of starts.values()) {
		closureStarts.push({ type: node.type, id: node.id });
	}
	const { closure, scopeOf } = collectClosure(db, principal, closureStarts);
	const fallbackScope = entry.targets[0]?.scopeKey ?? "";
	const nodes = new Map<string, DerivedNode>(starts);
	for (const node of closure.nodes) {
		if (!isDerivedType(node.type)) continue;
		const key = nodeKey(node.type, node.id);
		if (nodes.has(key)) continue;
		nodes.set(key, {
			type: node.type,
			id: node.id,
			scopeKey: scopeOf.get(key) ?? fallbackScope,
		});
	}
	const sortedNodes = [...nodes.values()].sort(
		(a, b) =>
			(a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	return {
		records: [...records.values()],
		sources: [...sources.values()],
		nodes: sortedNodes,
	};
}

/**
 * 他の principal / scope の行を指す target か。ID を指定して他人の行の値を消したり墓標を付けたりさせない
 * （行がまだない ID は、将来その ID の作成を止める墓標になるだけなので許す）。
 */
function hasForeignTarget(
	db: MemoryDb,
	principal: string,
	targets: readonly ForgetJournalTarget[],
): boolean {
	for (const target of targets) {
		if (target.type === "record") {
			if (
				recordOwnership(db, principal, target.scopeKey, target.id) === "foreign"
			) {
				return true;
			}
		} else if (target.type === "host_source") {
			const recordId = recordIdOfSourceKey(target.id);
			if (
				recordId !== null &&
				recordOwnership(db, principal, target.scopeKey, recordId) === "foreign"
			) {
				return true;
			}
		} else if (target.type === "state_item") {
			const owner = stateItemScope(db, target.id);
			if (
				owner !== null &&
				(owner.principal !== principal || owner.scopeKey !== target.scopeKey)
			) {
				return true;
			}
		}
	}
	return false;
}

// ---- plan ----

function targetOf(input: PlanForgetInput["target"]): ForgetJournalTarget {
	switch (input.type) {
		case "record":
			return { type: "record", id: input.recordId, scopeKey: input.scopeKey };
		case "host_source":
			return {
				type: "host_source",
				id: input.sourceKey,
				scopeKey: input.scopeKey,
			};
		case "state_item":
			return { type: "state_item", id: input.itemId, scopeKey: input.scopeKey };
		case "scope":
			return { type: "scope", id: input.scopeKey, scopeKey: input.scopeKey };
	}
}

/** 読み取りのみ（決定的）。DB の journal head の次の entry と、その時点の閉包の要約を返す。 */
export function planForget(
	db: MemoryDb,
	rawInput: PlanForgetInput,
): PlanForgetResult {
	const input = parsePlanForgetInput(rawInput);
	enterRead(db);
	if (!input.access.scopeKeys.includes(input.target.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = input.access.principal;
	if (hasForeignTarget(db, principal, [targetOf(input.target)])) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const head = readJournalHead(db);
	const entry = buildJournalEntry({
		seq: head.seq + 1,
		prevHash: head.hash,
		principal,
		targets: [targetOf(input.target)],
	});
	const set = resolveForgetSet(db, principal, entry, null);
	const providerRefs = new Set<string>();
	for (const ref of set.records) {
		for (const providerRef of listRecordProviders(db, ref.recordId)) {
			providerRefs.add(providerRef);
		}
	}
	const counts: Record<string, number> = {
		record: set.records.filter((ref) => recordIsLive(db, ref.recordId)).length,
		state_item: 0,
		external: 0,
	};
	const externalDependents: { providerRef: string; externalId: string }[] = [];
	for (const node of set.nodes) {
		if (!isTombstoned(db, node.type, node.id)) {
			counts[node.type] = (counts[node.type] ?? 0) + 1;
		}
		if (node.type === "external") {
			externalDependents.push(splitExternalNodeId(node.id));
		}
	}
	const plan: ForgetPlan = {
		entry,
		closure: { counts },
		externalProviders: [...providerRefs].sort(),
		externalDependents,
	};
	return { status: "planned", plan };
}

// ---- apply ----

function insertTombstone(
	db: MemoryDb,
	targetType: TombstoneTargetType,
	targetId: string,
	principal: string,
	scopeKey: string,
	forgetId: string,
	seq: number,
	journalSeq: number,
): void {
	guarded(() =>
		db
			.query(
				`INSERT INTO memory_tombstone
					(target_type, target_id, principal, scope_key, forget_id, seq, journal_seq)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT DO NOTHING`,
			)
			.run(
				targetType,
				targetId,
				principal,
				scopeKey,
				forgetId,
				seq,
				journalSeq,
			),
	);
}

function insertPendingExternal(
	db: MemoryDb,
	forgetId: string,
	providerRef: string,
	externalId: string,
	seq: number,
): void {
	guarded(() =>
		db
			.query(
				`INSERT INTO memory_forget_external (forget_id, provider_ref, external_id, state, updated_seq)
				VALUES (?, ?, ?, 'pending', ?)
				ON CONFLICT DO NOTHING`,
			)
			.run(forgetId, providerRef, externalId, seq),
	);
}

/** 記録済みの forget（journal_seq 一致）。entry と forgetId / hash が一致しなければ null。 */
function selectAppliedForget(
	db: MemoryDb,
	entry: ForgetJournalEntry,
): { readonly seq: number } | null {
	const row = guarded(() =>
		db
			.query(
				`SELECT forget_id, entry_hash, seq FROM memory_forget WHERE journal_seq = ?`,
			)
			.get(entry.seq),
	);
	if (row === null || row === undefined) return null;
	if (
		readText(row, "forget_id") !== entry.forgetId ||
		readText(row, "entry_hash") !== entry.hash
	) {
		return null;
	}
	return { seq: readInteger(row, "seq") };
}

/** `memory_forget.external_state` を `memory_forget_external` の行から集約し直す。 */
function refreshForgetExternalState(db: MemoryDb, forgetId: string): void {
	const rows = guarded(() =>
		db
			.query("SELECT state FROM memory_forget_external WHERE forget_id = ?")
			.all(forgetId),
	);
	const aggregate = aggregateExternal(
		rows.map((row) => pick(readText(row, "state"), EXTERNAL_DELETION_STATES)),
	);
	guarded(() =>
		db
			.query("UPDATE memory_forget SET external_state = ? WHERE forget_id = ?")
			.run(aggregate, forgetId),
	);
}

/**
 * entry を 1 つ適用する（`enterWrite` 済みの write transaction 内）。
 * - head の次の entry: 新規適用（memory_forget と head を記録）。
 * - 適用済み（seq <= head）の entry: DB の記録と forgetId / hash が一致すれば再適用（結果は同一）。
 *   一致しなければ `JOURNAL_ENTRY_INVALID`。scope target の再適用は、最初の適用より前に作られた行に限る
 *   （その後に作られた行を消さない）。
 * - それ以外（head の次でない新規、prevHash 不一致）は `JOURNAL_ENTRY_INVALID`。
 * 値の消去・閉包の墓標は、墓標の有無に関係なく毎回行う。
 */
function applyEntry(
	db: MemoryDb,
	entry: ForgetJournalEntry,
	atMs: number,
	opSeq: number,
): ForgetReceipt {
	if (!isSelfConsistent(entry)) {
		throw new MemoryStoreError("JOURNAL_ENTRY_INVALID");
	}
	for (const target of entry.targets) {
		if (target.type === "record" && !isRecordId(target.id)) {
			throw new MemoryStoreError("JOURNAL_ENTRY_INVALID");
		}
		if (target.type === "scope" && target.id !== target.scopeKey) {
			throw new MemoryStoreError("JOURNAL_ENTRY_INVALID");
		}
	}

	if (hasForeignTarget(db, entry.principal, entry.targets)) {
		throw new MemoryStoreError("JOURNAL_ENTRY_INVALID");
	}
	const head = readJournalHead(db);
	let isNew = false;
	let createdBefore: number | null = null;
	if (entry.seq === head.seq + 1) {
		if (entry.prevHash !== head.hash) {
			throw new MemoryStoreError("JOURNAL_ENTRY_INVALID");
		}
		isNew = true;
	} else if (entry.seq <= head.seq) {
		const applied = selectAppliedForget(db, entry);
		if (applied === null) throw new MemoryStoreError("JOURNAL_ENTRY_INVALID");
		createdBefore = applied.seq;
	} else {
		throw new MemoryStoreError("JOURNAL_ENTRY_INVALID");
	}

	const principal = entry.principal;
	// 閉包は apply 時点で再計算する（plan 後に増えた派生物も漏らさない）。
	const set = resolveForgetSet(db, principal, entry, createdBefore);

	const providerRefs = new Set<string>();
	for (const ref of set.records) {
		const info = scrubRecord(db, principal, ref.scopeKey, ref.recordId);
		for (const providerRef of info.providerRefs) providerRefs.add(providerRef);
		const sourceKey = recordSourceKey(ref.recordId);
		const newlyTombstoned = !isTombstoned(db, "record", ref.recordId);
		insertTombstone(
			db,
			"record",
			ref.recordId,
			principal,
			ref.scopeKey,
			entry.forgetId,
			opSeq,
			entry.seq,
		);
		insertTombstone(
			db,
			"source",
			sourceKey,
			principal,
			ref.scopeKey,
			entry.forgetId,
			opSeq,
			entry.seq,
		);
		// 過去の変更フィードの行に残る revision（本文の SHA-256）も消す。
		guarded(() =>
			db
				.query(
					`UPDATE memory_change SET revision = NULL
					WHERE principal = ? AND target_type = 'record' AND target_id = ? AND revision IS NOT NULL`,
				)
				.run(principal, ref.recordId),
		);
		if (info.transitioned || newlyTombstoned) {
			appendMemoryChange(db, {
				principal,
				scopeKey: ref.scopeKey,
				atMs,
				targetType: "record",
				targetId: ref.recordId,
				revision: null,
				status: "forgotten",
				forgetId: entry.forgetId,
			});
		}
	}
	for (const source of set.sources) {
		const newlyTombstoned = !isTombstoned(db, "source", source.sourceKey);
		insertTombstone(
			db,
			"source",
			source.sourceKey,
			principal,
			source.scopeKey,
			entry.forgetId,
			opSeq,
			entry.seq,
		);
		if (newlyTombstoned) {
			appendMemoryChange(db, {
				principal,
				scopeKey: source.scopeKey,
				atMs,
				targetType: "source",
				targetId: source.sourceKey,
				revision: null,
				status: "forgotten",
				forgetId: entry.forgetId,
			});
		}
	}
	// 閉包内の派生行: 値を消し、墓標を書く。
	for (const node of set.nodes) {
		let scopeKey = node.scopeKey;
		let transitioned = false;
		if (node.type === "state_item") {
			const scrubbed = scrubStateItem(db, principal, node.id, opSeq);
			scopeKey = scrubbed.scopeKey ?? scopeKey;
			transitioned = scrubbed.transitioned;
		}
		const newlyTombstoned = !isTombstoned(db, node.type, node.id);
		insertTombstone(
			db,
			node.type,
			node.id,
			principal,
			scopeKey,
			entry.forgetId,
			opSeq,
			entry.seq,
		);
		if (node.type === "external") {
			const external = splitExternalNodeId(node.id);
			insertPendingExternal(
				db,
				entry.forgetId,
				external.providerRef,
				external.externalId,
				opSeq,
			);
		}
		if (node.type === "state_item" && (newlyTombstoned || transitioned)) {
			appendMemoryChange(db, {
				principal,
				scopeKey,
				atMs,
				targetType: "state_item",
				targetId: node.id,
				revision: null,
				status: "forgotten",
				forgetId: entry.forgetId,
			});
		}
	}
	for (const providerRef of providerRefs) {
		insertPendingExternal(db, entry.forgetId, providerRef, "", opSeq);
	}

	if (isNew) {
		guarded(() => {
			db.query(
				`INSERT INTO memory_forget
						(forget_id, principal, request_json, local_state, external_state, journal_seq, entry_hash, seq, at_ms)
					VALUES (?, ?, ?, 'applied', 'none', ?, ?, ?, ?)`,
			).run(
				entry.forgetId,
				principal,
				canonicalJson({ targets: entry.targets }),
				entry.seq,
				entry.hash,
				opSeq,
				atMs,
			);
			db.query(
				`UPDATE memory_journal_state SET applied_head_seq = ?, applied_head_hash = ? WHERE id = 1`,
			).run(entry.seq, entry.hash);
		});
	}
	refreshForgetExternalState(db, entry.forgetId);
	return buildReceipt(db, entry.forgetId);
}

/** 書き込み。冪等。ホストの write transaction 内、同期。`enabled` に依存しない。 */
export function applyForget(
	db: MemoryDb,
	rawInput: ApplyForgetInput,
): ForgetReceipt {
	const input = parseApplyForgetInput(rawInput);
	const seq = enterWrite(db);
	return applyEntry(db, input.entry, input.clock.atMs, seq);
}

// ---- reconcile ----

/**
 * 書き込み。起動時（worker 起動前）に呼ぶ。ジャーナルの鎖を検証し、DB の head より進んでいる entry を順に再適用する。
 * `inconsistent` の場合は何も書かない（呼び出したホストは Memory の読み出し・抽出を止める）:
 * - 鎖が壊れている・entry が改ざんされている・DB の記録と食い違う → `JOURNAL_CHAIN_BROKEN`
 * - ジャーナルが DB の head より短い → `JOURNAL_TRUNCATED`
 * - ジャーナルが空なのに DB に適用記録／墓標がある → `JOURNAL_MISSING`
 * `inconsistent` でも `enterWrite` が操作 seq（`memory_seq`）を 1 つ進める（行は書かない）。
 * `reapplied > 0` なら結果に `feedResyncRequired: true` を付ける: 復元された古い DB の `memory_seq` と変更フィードの番号は
 * 失われた期間の分だけ巻き戻っており、巻き戻り前のカーソルを持つ購読者は忘却通知を取りこぼす（カーソルを破棄して全再同期する）。
 * 限界: 「古い DB を復元し、さらに末尾が切れたジャーナル」は本体だけでは検出できない（DB が古いため）。
 */
export function reconcileForgetJournal(
	db: MemoryDb,
	rawInput: ReconcileForgetJournalInput,
): ReconcileForgetJournalResult {
	const input = parseReconcileForgetJournalInput(rawInput);
	const opSeq = enterWrite(db);
	const entries = input.entries as readonly ForgetJournalEntry[];
	if (verifyForgetJournal(entries).status === "inconsistent") {
		return { status: "inconsistent", reasonCode: "JOURNAL_CHAIN_BROKEN" };
	}
	const head = readJournalHead(db);
	if (entries.length === 0) {
		const tombstone = guarded(() =>
			db.query("SELECT 1 AS found FROM memory_tombstone LIMIT 1").get(),
		);
		if (head.seq > 0 || (tombstone !== null && tombstone !== undefined)) {
			return { status: "inconsistent", reasonCode: "JOURNAL_MISSING" };
		}
		return { status: "ok", reapplied: 0 };
	}
	if (entries.length < head.seq) {
		return { status: "inconsistent", reasonCode: "JOURNAL_TRUNCATED" };
	}
	const maxTombstoneSeq = guarded(() =>
		db.query("SELECT MAX(journal_seq) AS m FROM memory_tombstone").get(),
	);
	const tombstoneSeq = readRow(maxTombstoneSeq)["m"];
	if (typeof tombstoneSeq === "number" && tombstoneSeq > entries.length) {
		return { status: "inconsistent", reasonCode: "JOURNAL_TRUNCATED" };
	}
	if (head.seq > 0 && entries[head.seq - 1]?.hash !== head.hash) {
		return { status: "inconsistent", reasonCode: "JOURNAL_CHAIN_BROKEN" };
	}
	const applied = guarded(() =>
		db
			.query("SELECT journal_seq, forget_id, entry_hash FROM memory_forget")
			.all(),
	);
	for (const row of applied) {
		const journalSeq = readInteger(row, "journal_seq");
		const entry = entries[journalSeq - 1];
		if (
			entry === undefined ||
			entry.forgetId !== readText(row, "forget_id") ||
			entry.hash !== readText(row, "entry_hash")
		) {
			return { status: "inconsistent", reasonCode: "JOURNAL_CHAIN_BROKEN" };
		}
	}
	let reapplied = 0;
	for (let index = head.seq; index < entries.length; index += 1) {
		applyEntry(
			db,
			entries[index] as ForgetJournalEntry,
			input.clock.atMs,
			opSeq,
		);
		reapplied += 1;
	}
	return reapplied > 0
		? { status: "ok", reapplied, feedResyncRequired: true }
		: { status: "ok", reapplied };
}

// ---- receipt ----

const EXTERNAL_PRIORITY: readonly ExternalDeletionState[] = [
	"failed",
	"pending",
	"unverified",
];

function aggregateExternal(
	states: readonly ExternalDeletionState[],
): ForgetExternalState {
	if (states.length === 0) return "none";
	for (const state of EXTERNAL_PRIORITY) {
		if (states.includes(state)) return state;
	}
	return "confirmed";
}

function buildReceipt(db: MemoryDb, forgetId: string): ForgetReceipt {
	const rows = guarded(() =>
		db
			.query(
				`SELECT provider_ref, external_id, state FROM memory_forget_external
				WHERE forget_id = ? ORDER BY provider_ref ASC, external_id ASC`,
			)
			.all(forgetId),
	);
	const externalDeletions: ExternalDeletion[] = rows.map((row) => {
		const externalId = readText(row, "external_id");
		return {
			providerRef: readText(row, "provider_ref"),
			externalId: externalId === "" ? null : externalId,
			state: pick(readText(row, "state"), EXTERNAL_DELETION_STATES),
		};
	});
	const external = aggregateExternal(externalDeletions.map((d) => d.state));
	return {
		forgetId,
		local: "applied",
		external,
		externalDeletions,
		completed: external === "none" || external === "confirmed",
	};
}

/**
 * forget が呼び出し元に見えるか。他 principal の forget は `missing`（存在を漏らさない）、
 * 対象 scope に許可外が含まれると `not_permitted`。
 */
function forgetVisibility(
	db: MemoryDb,
	access: GetForgetReceiptInput["access"],
	forgetId: string,
): "ok" | "missing" | "not_permitted" {
	const row = guarded(() =>
		db
			.query("SELECT principal FROM memory_forget WHERE forget_id = ?")
			.get(forgetId),
	);
	if (row === null || row === undefined) return "missing";
	if (readText(row, "principal") !== access.principal) return "missing";
	const scopes = guarded(() =>
		db
			.query(
				`SELECT DISTINCT json_extract(j.value, '$.scopeKey') AS scope_key
				FROM memory_forget f, json_each(f.request_json, '$.targets') j
				WHERE f.forget_id = ?`,
			)
			.all(forgetId),
	);
	const permitted = new Set(access.scopeKeys);
	for (const scope of scopes) {
		if (!permitted.has(readText(scope, "scope_key"))) return "not_permitted";
	}
	return "ok";
}

/** 読み取り。 */
export function getForgetReceipt(
	db: MemoryDb,
	rawInput: GetForgetReceiptInput,
): GetForgetReceiptResult {
	const input = parseGetForgetReceiptInput(rawInput);
	enterRead(db);
	const visibility = forgetVisibility(db, input.access, input.forgetId);
	if (visibility !== "ok") return { status: visibility };
	return { status: "found", receipt: buildReceipt(db, input.forgetId) };
}

// ---- 外部削除の確認 ----

/**
 * 書き込み。外部（プロバイダー、または外部派生物 `(providerRef, externalId)`）の削除確認をホストが記録する。
 * `externalId` を省略すると、その forget に登録された `providerRef` の全行（プロバイダー単位と外部派生物単位）が対象。
 * 最後に記録した状態が有効（`confirmed` の後に `failed` を記録すれば `failed` になる）。receipt は集約で、
 * `completed` は local applied かつ external が `none` / `confirmed` のときだけ true。
 */
export function recordExternalDeletion(
	db: MemoryDb,
	rawInput: RecordExternalDeletionInput,
): RecordExternalDeletionResult {
	const input = parseRecordExternalDeletionInput(rawInput);
	const opSeq = enterWrite(db);
	const visibility = forgetVisibility(db, input.access, input.forgetId);
	if (visibility !== "ok") return { status: visibility };
	const params: SqlValue[] = [input.forgetId, input.providerRef];
	let filter = "";
	const externalId = ownValue(input, "externalId");
	if (externalId !== undefined) {
		filter = " AND external_id = ?";
		params.push(externalId);
	}
	const known = guarded(() =>
		db
			.query(
				`SELECT COUNT(*) AS n FROM memory_forget_external
				WHERE forget_id = ? AND provider_ref = ?${filter}`,
			)
			.get(...params),
	);
	if (readInteger(known, "n") === 0) return { status: "unknown_provider" };
	guarded(() =>
		db
			.query(
				`UPDATE memory_forget_external SET state = ?, updated_seq = ?
				WHERE forget_id = ? AND provider_ref = ?${filter} AND state <> ?`,
			)
			.run(input.state, opSeq, ...params, input.state),
	);
	refreshForgetExternalState(db, input.forgetId);
	return { status: "recorded", receipt: buildReceipt(db, input.forgetId) };
}

// ---- ExternalDependent の登録 ----

function externalNodeId(providerRef: string, externalId: string): string {
	return `${providerRef}:${externalId}`;
}

function sourceIsTombstoned(db: MemoryDb, sourceKey: string): boolean {
	if (isTombstoned(db, "source", sourceKey)) return true;
	const recordId = recordIdOfSourceKey(sourceKey);
	return recordId !== null && isTombstoned(db, "record", recordId);
}

interface ExistingEdges {
	readonly principal: string;
	readonly scopeKey: string;
	readonly keys: ReadonlySet<string>;
}

function readExistingEdges(db: MemoryDb, nodeId: string): ExistingEdges | null {
	const rows = guarded(() =>
		db
			.query(
				`SELECT principal, scope_key, dependency_type, dependency_id FROM memory_dependency
				WHERE dependent_type = 'external' AND dependent_id = ?`,
			)
			.all(nodeId),
	);
	const first = rows[0];
	if (first === undefined) return null;
	const keys = new Set<string>();
	for (const row of rows) {
		keys.add(
			nodeKey(readText(row, "dependency_type"), readText(row, "dependency_id")),
		);
	}
	return {
		principal: readText(first, "principal"),
		scopeKey: readText(first, "scope_key"),
		keys,
	};
}

/**
 * 書き込み。外部ドメインの派生物を依存閉包に登録する（役割は常に `derived_from`、置き換え）。
 * 全件を検査してから書く（1 件でも拒否なら何も書かない）。忘却済み（墓標あり）の対象からは派生させない。
 * 登録は Memory 所有データを変えないので、変更フィードには触れない。
 */
export function registerExternalDependents(
	db: MemoryDb,
	rawInput: RegisterExternalDependentsInput,
): RegisterExternalDependentsResult {
	const input = parseRegisterExternalDependentsInput(rawInput);
	enterWrite(db);
	if (!input.access.scopeKeys.includes(input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	const principal = input.access.principal;
	const scopeKey = input.scopeKey;
	for (const dependent of input.dependents) {
		const nodeId = externalNodeId(dependent.providerRef, dependent.externalId);
		if (isTombstoned(db, "external", nodeId)) {
			return { status: "rejected", reasonCode: "TOMBSTONED" };
		}
		const existing = readExistingEdges(db, nodeId);
		if (
			existing !== null &&
			(existing.principal !== principal || existing.scopeKey !== scopeKey)
		) {
			return { status: "rejected", reasonCode: "EXTERNAL_ID_IN_USE" };
		}
		for (const ref of dependent.dependsOn) {
			if (ref.type === "source") {
				if (sourceIsTombstoned(db, ref.id)) {
					return { status: "rejected", reasonCode: "TOMBSTONED" };
				}
				continue;
			}
			const owner = stateItemScope(db, ref.id);
			if (
				owner === null ||
				owner.principal !== principal ||
				owner.scopeKey !== scopeKey
			) {
				return { status: "rejected", reasonCode: "DEPENDENCY_MISSING" };
			}
			if (isTombstoned(db, "state_item", ref.id)) {
				return { status: "rejected", reasonCode: "TOMBSTONED" };
			}
			const status = guarded(() =>
				db
					.query("SELECT status FROM memory_state_item WHERE item_id = ?")
					.get(ref.id),
			);
			if (status !== null && status !== undefined) {
				if (readText(status, "status") === "forgotten") {
					return { status: "rejected", reasonCode: "TOMBSTONED" };
				}
			}
		}
	}
	let registered = 0;
	let unchanged = 0;
	for (const dependent of input.dependents) {
		const nodeId = externalNodeId(dependent.providerRef, dependent.externalId);
		const wanted = new Set(
			dependent.dependsOn.map((ref) => nodeKey(ref.type, ref.id)),
		);
		const existing = readExistingEdges(db, nodeId);
		if (
			existing !== null &&
			existing.keys.size === wanted.size &&
			[...wanted].every((key) => existing.keys.has(key))
		) {
			unchanged += 1;
			continue;
		}
		guarded(() =>
			db
				.query(
					`DELETE FROM memory_dependency
					WHERE dependent_type = 'external' AND dependent_id = ? AND principal = ? AND scope_key = ?`,
				)
				.run(nodeId, principal, scopeKey),
		);
		for (const ref of dependent.dependsOn) {
			addDependency(db, {
				principal,
				scopeKey,
				dependentType: "external",
				dependentId: nodeId,
				dependencyType: ref.type,
				dependencyId: ref.id,
				role: "derived_from",
			});
		}
		registered += 1;
	}
	return { status: "registered", registered, unchanged };
}

/**
 * 書き込み。外部が自分で派生物を消した／作り直す場合の登録解除（忘却ではない。墓標・ジャーナルを作らない）。
 * 同じ principal / scope で登録された依存辺だけを消す。
 */
export function unregisterExternalDependents(
	db: MemoryDb,
	rawInput: UnregisterExternalDependentsInput,
): UnregisterExternalDependentsResult {
	const input = parseUnregisterExternalDependentsInput(rawInput);
	enterWrite(db);
	if (!input.access.scopeKeys.includes(input.scopeKey)) {
		return { status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" };
	}
	let removed = 0;
	for (const key of input.dependents) {
		const nodeId = externalNodeId(key.providerRef, key.externalId);
		const count = guarded(() =>
			db
				.query(
					`SELECT COUNT(*) AS n FROM memory_dependency
					WHERE dependent_type = 'external' AND dependent_id = ? AND principal = ? AND scope_key = ?`,
				)
				.get(nodeId, input.access.principal, input.scopeKey),
		);
		if (readInteger(count, "n") === 0) continue;
		guarded(() =>
			db
				.query(
					`DELETE FROM memory_dependency
					WHERE dependent_type = 'external' AND dependent_id = ? AND principal = ? AND scope_key = ?`,
				)
				.run(nodeId, input.access.principal, input.scopeKey),
		);
		removed += 1;
	}
	return { status: "unregistered", removed };
}
