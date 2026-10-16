import assert from "node:assert/strict";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { classifyValidity, CONTRACT_VERSIONS } from "eumenes-memory";
import {
	assertUserState,
	captureRecord,
	evictRetainedRecords,
	getForgetReceipt,
	listMemoryChanges,
	listState,
	readRecord,
	readRetainedRecord,
	recordExternalDeletion,
	registerExternalDependents,
	retainRecord,
	retainedRecordStats,
} from "eumenes-memory/sqlite";
import { ACCESS, SCOPE, StandaloneHost } from "./host.ts";

export interface CheckResult {
	name: string;
	status: "passed" | "failed";
	durationMs: number;
	error?: string;
}
export type Check = (
	name: string,
	operation: () => unknown | Promise<unknown>,
) => Promise<void>;

/** No model, no library internals: checks the host's real file/WAL integration. */
export async function coreChecks(
	directory: string,
	check: Check,
): Promise<void> {
	let host = new StandaloneHost(directory);
	const readInput = {
		contractVersion: CONTRACT_VERSIONS.records,
		access: ACCESS,
		scopeKey: SCOPE,
	};
	const writeInput = { ...readInput, clock: { atMs: 1000 } };
	const input = {
		...writeInput,
		origin: { namespace: "example", kind: "document", id: "reference" },
		mediaType: "text/plain" as const,
		content: "参考資料：受付は午前9時です。",
		captureState: "complete" as const,
	};
	try {
		const record = host.write((db) => captureRecord(db, input));
		assert.equal(record.status, "captured");
		if (record.status !== "captured") throw new Error("capture failed");
		await check(
			"records: capture / idempotence / revision / scoped access",
			() => {
				assert.deepEqual(
					host.write((db) => captureRecord(db, input)),
					{ ...record, created: false },
				);
				const newer = host.write((db) =>
					captureRecord(db, {
						...input,
						content: "参考資料：受付は午前10時です。",
					}),
				);
				assert.equal(newer.status, "captured");
				if (newer.status !== "captured") throw new Error("capture failed");
				assert.equal(newer.recordId, record.recordId);
				assert.notEqual(newer.revision, record.revision);
				const old = host.read((db) =>
					readRecord(db, {
						...readInput,
						recordId: record.recordId,
						revision: record.revision,
					}),
				);
				assert.equal(old.status, "available");
				if (old.status === "available")
					assert.equal(old.content, input.content);
				assert.equal(
					host.read((db) =>
						readRecord(db, {
							...readInput,
							access: { ...ACCESS, principal: "another:owner" },
							recordId: record.recordId,
						}),
					).status,
					"missing",
				);
				assert.equal(
					host.read((db) =>
						listState(db, { ...readInput, scopeKey: "forbidden:scope" }),
					).status,
					"blocked",
				);
			},
		);
		await check("host: transaction rollback", () => {
			assert.throws(
				() =>
					host.write((db) => {
						captureRecord(db, { ...input, content: "rollback" });
						throw new Error("rollback probe");
					}),
				/rollback probe/,
			);
			const current = host.read((db) =>
				readRecord(db, { ...readInput, recordId: record.recordId }),
			);
			assert.equal(current.status, "available");
			if (current.status === "available")
				assert.equal(current.content, "参考資料：受付は午前10時です。");
		});
		await check(
			"state: reject fabricated quote / record evidence / external dependency",
			() => {
				const stateInput = {
					...writeInput,
					kind: "personal_fact" as const,
					subject: "self" as const,
					semanticKey: "reference_hours",
					value: { text: "午前9時", polarity: "affirmed" as const },
					origin: "agent_inferred" as const,
					evidence: [
						{
							source: {
								...record.ref,
								range: {
									startByte: 0,
									endByte: Buffer.byteLength(input.content),
								},
							},
							quote: input.content,
						},
					],
					sources: [
						{
							...record.ref,
							principal: ACCESS.principal,
							scopeKey: SCOPE,
							status: "available" as const,
							content: input.content,
							ordinal: 1,
						},
					],
				};
				const rejected = host.write((db) =>
					assertUserState(db, {
						...stateInput,
						evidence: [{ ...stateInput.evidence[0]!, quote: "架空の引用" }],
					}),
				);
				assert.deepEqual(rejected, {
					status: "rejected",
					reasonCode: "QUOTE_MISMATCH",
				});
				assert.equal(host.list().length, 0);
				const applied = host.write((db) => assertUserState(db, stateInput));
				assert.equal(applied.status, "applied");
				if (applied.status !== "applied") throw new Error("State write failed");
				assert.equal(
					host.write((db) =>
						registerExternalDependents(db, {
							...writeInput,
							dependents: [
								{
									providerRef: "example",
									externalId: "derived",
									dependsOn: [{ type: "state_item", id: applied.item.itemId }],
								},
							],
						}),
					).status,
					"registered",
				);
			},
		);
		const snapshot = join(directory, "before-forget.db");
		host.snapshot(snapshot);
		await check(
			"forget: record closes over state and external dependents / tombstone",
			() => {
				host.forget({
					type: "record",
					recordId: record.recordId,
					scopeKey: SCOPE,
				});
				assert.equal(host.list().length, 0);
				assert.equal(
					host.read((db) =>
						readRecord(db, { ...readInput, recordId: record.recordId }),
					).status,
					"forgotten",
				);
				assert.deepEqual(
					host.write((db) => captureRecord(db, input)),
					{ status: "blocked", reasonCode: "TOMBSTONED" },
				);
				const entries = readFileSync(host.journalPath, "utf8")
					.trim()
					.split("\n");
				const entry = JSON.parse(entries[0]!);
				const receiptInput = {
					contractVersion: CONTRACT_VERSIONS.lifecycle,
					access: ACCESS,
					forgetId: entry.forgetId,
				};
				const receipt = host.read((db) => getForgetReceipt(db, receiptInput));
				assert.equal(receipt.status, "found");
				if (receipt.status === "found") {
					assert.equal(receipt.receipt.external, "pending");
					assert.equal(receipt.receipt.completed, false);
				}
				const confirmed = host.write((db) =>
					recordExternalDeletion(db, {
						...receiptInput,
						clock: input.clock,
						providerRef: "example",
						externalId: "derived",
						state: "confirmed",
					}),
				);
				assert.equal(confirmed.status, "recorded");
				if (confirmed.status === "recorded")
					assert.equal(confirmed.receipt.completed, true);
				const feed = host.read((db) =>
					listMemoryChanges(db, {
						contractVersion: CONTRACT_VERSIONS.external,
						access: ACCESS,
						scopeKeys: [SCOPE],
						afterSeq: 0,
						limit: 100,
					}),
				);
				assert.equal(feed.status, "ok");
				if (feed.status === "ok")
					assert.ok(
						feed.changes.some((change) => change.status === "forgotten"),
					);
			},
		);
		await check(
			"host: old DB restore replays latest journal before reads",
			() => {
				host.close();
				rmSync(`${host.path}-wal`, { force: true });
				rmSync(`${host.path}-shm`, { force: true });
				copyFileSync(snapshot, host.path);
				host = new StandaloneHost(directory);
				assert.ok(host.startup.reapplied > 0);
				assert.equal(host.startup.feedResyncRequired, true);
				assert.equal(host.list().length, 0);
				assert.equal(
					host.read((db) =>
						readRecord(db, { ...readInput, recordId: record.recordId }),
					).status,
					"forgotten",
				);
				host.close();
				host = new StandaloneHost(directory);
				assert.equal(host.startup.reapplied, 0);
			},
		);
		await check(
			"retention: freshness / expiry / eviction; ordinary records survive",
			() => {
				const normal = host.write((db) =>
					captureRecord(db, {
						...input,
						origin: { ...input.origin, id: "normal" },
					}),
				);
				const retained = host.write((db) =>
					retainRecord(db, {
						record: { ...input, origin: { ...input.origin, id: "cache" } },
						freshUntilMs: 2000,
						idleTtlMs: 500,
					}),
				);
				if (retained.status !== "captured" || normal.status !== "captured")
					throw new Error("capture failed");
				const retainedInput = { ...writeInput, recordId: retained.recordId };
				assert.equal(
					host.read((db) => readRetainedRecord(db, retainedInput)).status,
					"available",
				);
				assert.equal(
					host.read((db) =>
						readRetainedRecord(db, { ...retainedInput, clock: { atMs: 1501 } }),
					).status,
					"miss",
				);
				host.write((db) =>
					evictRetainedRecords(db, {
						...writeInput,
						clock: { atMs: 1501 },
						limit: 10,
					}),
				);
				assert.equal(
					host.read((db) => retainedRecordStats(db, writeInput)).entries,
					0,
				);
				assert.equal(
					host.read((db) =>
						readRecord(db, { ...readInput, recordId: normal.recordId }),
					).status,
					"available",
				);
			},
		);
		await check("temporal: current / past / future / unknown", () => {
			const period = { fromMs: 1000, untilMs: 2000, basis: "stated" as const };
			assert.equal(classifyValidity(period, 999), "future");
			assert.equal(classifyValidity(period, 1000), "current");
			assert.equal(classifyValidity(period, 2000), "past");
			assert.equal(classifyValidity(undefined, 1000), "unknown");
		});
	} finally {
		host.close();
	}
	await check(
		"host: crash between journal and apply / corrupted or missing journal rejects startup",
		() => {
			const crashDir = join(directory, "crash");
			let crashHost = new StandaloneHost(crashDir);
			assert.throws(
				() => crashHost.forget({ type: "scope", scopeKey: SCOPE }, true),
				/simulated_crash/,
			);
			crashHost.close();
			crashHost = new StandaloneHost(crashDir);
			assert.equal(crashHost.startup.reapplied, 1);
			crashHost.close();
			const journal = join(crashDir, "forget.jsonl");
			writeFileSync(journal, "{broken\n");
			assert.throws(() => new StandaloneHost(crashDir));
			rmSync(journal);
			assert.throws(() => new StandaloneHost(crashDir), /journal is missing/);
			const truncated = join(directory, "truncated");
			mkdirSync(truncated);
			copyFileSync(join(crashDir, "memory.db"), join(truncated, "memory.db"));
			writeFileSync(join(truncated, "forget.jsonl"), "");
			assert.throws(() => new StandaloneHost(truncated), /JOURNAL_MISSING/);
		},
	);
}
