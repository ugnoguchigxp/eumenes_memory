/**
 * Records / Forget のシナリオ・fixture 実行で共通に使う部品。公開面（"eumenes-memory/sqlite"）の
 * 関数と、テスト用 Writer だけを使う。
 */
import {
	applyForget,
	captureRecord,
	planForget,
	reconcileForgetJournal,
	readRecord,
} from "eumenes-memory/sqlite";
import type { AccessContext, SourceRef } from "eumenes-memory";
import type {
	ForgetJournalEntry,
	ForgetPlan,
	ForgetReceipt,
	MemoryDb,
	ReadRecordResult,
} from "eumenes-memory/sqlite";
import type { TestStore } from "../support/store.ts";

export const OWNER = "local:owner";
export const ALL_SCOPES = ["scope:a", "scope:b", "scope:c"] as const;

export function accessFor(
	scopeKeys: readonly string[] = ALL_SCOPES,
	principal: string = OWNER,
): AccessContext {
	return { principal, scopeKeys, purpose: "test", policyRevision: "1" };
}

export interface CaptureSpec {
	readonly scopeKey?: string;
	readonly origin: string;
	readonly content: string;
	readonly mediaType?: "text/plain" | "text/markdown" | "application/json";
	readonly captureState?: "complete" | "partial";
	readonly providerRef?: string;
	readonly atMs?: number;
	readonly principal?: string;
}

export interface Captured {
	readonly recordId: string;
	readonly revision: string;
	readonly digest: string;
	readonly ref: SourceRef;
	readonly scopeKey: string;
}

export function capture(store: TestStore, spec: CaptureSpec): Captured {
	const scopeKey = spec.scopeKey ?? "scope:a";
	const result = store.write((db) =>
		captureRecord(db, {
			contractVersion: 1,
			access: accessFor(ALL_SCOPES, spec.principal ?? OWNER),
			scopeKey,
			clock: { atMs: spec.atMs ?? 1 },
			origin: { namespace: "web", kind: "page", id: spec.origin },
			mediaType: spec.mediaType ?? "text/plain",
			content: spec.content,
			captureState: spec.captureState ?? "complete",
			...(spec.providerRef === undefined
				? {}
				: { providerRef: spec.providerRef }),
		}),
	);
	if (result.status !== "captured") {
		throw new Error(`capture blocked: ${result.reasonCode}`);
	}
	return {
		recordId: result.recordId,
		revision: result.revision,
		digest: result.digest,
		ref: result.ref,
		scopeKey,
	};
}

export function readOf(
	db: MemoryDb,
	recordId: string,
	scopeKey = "scope:a",
	revision?: string,
): ReadRecordResult {
	return readRecord(db, {
		contractVersion: 1,
		access: accessFor(),
		scopeKey,
		recordId,
		...(revision === undefined ? {} : { revision }),
	});
}

/** plan → apply（ホストのジャーナル追記を省いた形）。entry を返し、呼び出し側がジャーナル配列へ積む。 */
export function forgetRecord(
	store: TestStore,
	target: Parameters<typeof planForget>[1]["target"],
	atMs = 100,
): {
	readonly plan: ForgetPlan;
	readonly entry: ForgetJournalEntry;
	readonly receipt: ForgetReceipt;
} {
	const planned = store.read((db) =>
		planForget(db, {
			contractVersion: 1,
			access: accessFor(),
			target,
			clock: { atMs },
		}),
	);
	if (planned.status !== "planned") throw new Error("plan blocked");
	const receipt = store.write((db) =>
		applyForget(db, {
			contractVersion: 1,
			entry: planned.plan.entry,
			clock: { atMs },
		}),
	);
	return { plan: planned.plan, entry: planned.plan.entry, receipt };
}

export function reconcile(
	store: TestStore,
	entries: readonly unknown[],
	atMs = 200,
) {
	return store.write((db) =>
		reconcileForgetJournal(db, {
			contractVersion: 1,
			entries: entries as readonly ForgetJournalEntry[],
			clock: { atMs },
		}),
	);
}

/** memory_ 表（seq を除く）の全行を、比較可能な文字列にする。 */
export function dumpTables(store: TestStore): string {
	const tables = store.writer
		.query(
			`SELECT name FROM sqlite_master
			WHERE type = 'table' AND name LIKE 'memory\\_%' ESCAPE '\\'
				AND name <> 'memory_seq'
			ORDER BY name`,
		)
		.all() as { name: string }[];
	const out: Record<string, unknown[]> = {};
	for (const { name } of tables) {
		out[name] = store.writer.query(`SELECT * FROM ${name} ORDER BY 1, 2`).all();
	}
	return JSON.stringify(out);
}

/** memory_ 表のどこかに文字列 `needle` が残っているか。 */
export function tablesContain(store: TestStore, needle: string): boolean {
	const tables = store.writer
		.query(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory\\_%' ESCAPE '\\'`,
		)
		.all() as { name: string }[];
	for (const { name } of tables) {
		const rows = store.writer.query(`SELECT * FROM ${name}`).all();
		for (const row of rows) {
			for (const value of Object.values(row as Record<string, unknown>)) {
				if (typeof value === "string" && value.includes(needle)) return true;
				if (
					value instanceof Uint8Array &&
					Buffer.from(value).includes(needle)
				) {
					return true;
				}
			}
		}
	}
	return false;
}
