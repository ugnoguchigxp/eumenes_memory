/**
 * ExternalDependent の登録と解除。忘却のジャーナルや変更フィードは作らない。
 * 忘却の適用は `index.ts`。node の ID 形式は `keys.ts` が所有する。
 */
import type {
	RegisterExternalDependentsInput,
	RegisterExternalDependentsResult,
	UnregisterExternalDependentsInput,
	UnregisterExternalDependentsResult,
} from "../../../contracts/external.ts";
import {
	parseRegisterExternalDependentsInput,
	parseUnregisterExternalDependentsInput,
} from "../service/external-parse.ts";
import { recordIdOfSourceKey } from "../service/targets.ts";
import { addDependency } from "../../../infrastructure/sqlite/dependency.ts";
import {
	guarded,
	readInteger,
	readText,
} from "../../../infrastructure/sqlite/db.ts";
import type { MemoryDb } from "../../../infrastructure/sqlite/db.ts";
import { enterWrite } from "../../../infrastructure/sqlite/session.ts";
import { stateItemScope } from "../../state/sqlite.ts";
import { isTombstoned } from "../../../infrastructure/sqlite/tombstone.ts";
import { externalNodeId, nodeKey } from "./keys.ts";

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
			if (
				isTombstoned(db, "state_item", ref.id) ||
				owner.status === "forgotten"
			) {
				return { status: "rejected", reasonCode: "TOMBSTONED" };
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
