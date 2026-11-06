/** Runs outside the checkout, using only the extracted package (no tsconfig path aliases). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSIONS, verifyForgetJournal } from "eumenes-memory";
import {
	migrations,
	assertMemorySchema,
	checkHostMigrations,
	captureRecord,
	readRecord,
	assertUserState,
	listState,
	readStateFact,
	planForget,
	applyForget,
	reconcileForgetJournal,
	retainRecord,
	readRetainedRecord,
} from "eumenes-memory/sqlite";
const { DatabaseSync } = process.versions.bun
	? { DatabaseSync: (await import("bun:sqlite")).Database }
	: await import("node:sqlite");
const dir = mkdtempSync(join(tmpdir(), "memory-package-"));
const file = join(dir, "memory.db");
let native = new DatabaseSync(file);
let transactional = false;
const db = {
	exec: (s) => native.exec(s),
	query: (s) => native.prepare(s),
	get inTransaction() {
		return transactional;
	},
};
function write(op) {
	db.exec("BEGIN");
	transactional = true;
	try {
		const v = op();
		db.exec("COMMIT");
		return v;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	} finally {
		transactional = false;
	}
}
const access = {
	principal: "synthetic-owner",
	scopeKeys: ["scope"],
	purpose: "package.check",
	policyRevision: "1",
};
const readCommon = { contractVersion: 1, access, scopeKey: "scope" };
const common = { ...readCommon, clock: { atMs: 100 } };
const checks = [];
try {
	db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
	// Real supported upgrade, not a made-up test schema.
	for (const sql of migrations.slice(0, 7)) write(() => db.exec(sql));
	assert.throws(() => assertMemorySchema(db), /SCHEMA_OUTDATED/);
	checks.push("old schema rejected");
	for (const sql of migrations.slice(7)) write(() => db.exec(sql));
	assertMemorySchema(db);
	assert.deepEqual(checkHostMigrations(migrations), []);
	assert.notDeepEqual(checkHostMigrations([...migrations].reverse()), []);
	checks.push("upgrade and migration integrity");
	const capture = {
		...common,
		origin: { namespace: "test", kind: "document", id: "one" },
		content: "私は紅茶が好き",
		mediaType: "text/plain",
		captureState: "complete",
	};
	assert.throws(() => captureRecord(db, capture), /NOT_IN_TRANSACTION/);
	const record = write(() => captureRecord(db, capture));
	assert.equal(record.status, "captured");
	assert.equal(
		readRecord(db, { ...readCommon, recordId: record.recordId }).status,
		"available",
	);
	assert.equal(
		readRecord(db, {
			...readCommon,
			access: { ...access, principal: "other" },
			recordId: record.recordId,
		}).status,
		"missing",
	);
	checks.push("capture read and foreign principal");
	const source = {
		namespace: "conversation",
		kind: "message",
		id: "source",
		representation: "text",
		revision: "1",
		digest: createHash("sha256").update(capture.content).digest("hex"),
		principal: access.principal,
		scopeKey: "scope",
		status: "available",
		content: capture.content,
		ordinal: 1,
	};
	const {
		principal: _principal,
		scopeKey: _scope,
		status: _status,
		content: _content,
		ordinal: _ordinal,
		...ref
	} = source;
	const state = {
		...common,
		subject: "self",
		kind: "preference",
		semanticKey: "drink",
		origin: "user_confirmed",
		value: { text: "紅茶が好き", polarity: "affirmed" },
		evidence: [
			{
				source: {
					...ref,
					range: { startByte: 0, endByte: Buffer.byteLength(source.content) },
				},
				quote: source.content,
			},
		],
		sources: [source],
	};
	const first = write(() => assertUserState(db, state));
	assert.equal(first.status, "applied");
	const second = write(() =>
		assertUserState(db, {
			...state,
			value: { text: "紅茶を好む", polarity: "affirmed" },
			replaces: { itemId: first.item.itemId, revision: first.item.revision },
		}),
	);
	assert.equal(second.status, "applied");
	const stale = write(() =>
		assertUserState(db, {
			...state,
			replaces: { itemId: first.item.itemId, revision: first.item.revision },
		}),
	);
	assert.notEqual(stale.status, "applied");
	assert.equal(
		readStateFact(db, { ...readCommon, itemId: second.item.itemId }).status,
		"ok",
	);
	checks.push("state assertion correction and stale CAS");
	const retained = write(() =>
		retainRecord(db, {
			record: { ...capture, origin: { ...capture.origin, id: "cache" } },
			freshUntilMs: 300,
			idleTtlMs: 50,
		}),
	);
	assert.equal(retained.status, "captured");
	assert.equal(
		readRetainedRecord(db, { ...common, recordId: retained.recordId }).status,
		"available",
	);
	assert.equal(
		readRetainedRecord(db, {
			...common,
			clock: { atMs: 151 },
			recordId: retained.recordId,
		}).status,
		"miss",
	);
	checks.push("retention boundaries");
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	copyFileSync(file, join(dir, "before.db"));
	const planned = planForget(db, {
		contractVersion: 1,
		access,
		target: { type: "scope", scopeKey: "scope" },
		clock: { atMs: 200 },
	});
	assert.equal(planned.status, "planned");
	const journal = [planned.plan.entry];
	assert.equal(verifyForgetJournal(journal).status, "ok");
	assert.equal(
		write(() =>
			applyForget(db, {
				contractVersion: 1,
				entry: journal[0],
				clock: { atMs: 200 },
			}),
		).completed,
		true,
	);
	assert.equal(listState(db, readCommon).items.length, 0);
	assert.equal(
		readRecord(db, { ...readCommon, recordId: record.recordId }).status,
		"forgotten",
	);
	checks.push("scope forget and nonresurrection");
	native.close();
	native = new DatabaseSync(join(dir, "before.db"));
	const recovered = write(() =>
		reconcileForgetJournal(db, {
			contractVersion: 1,
			entries: journal,
			clock: { atMs: 300 },
		}),
	);
	assert.equal(recovered.status, "ok");
	assert.equal(recovered.reapplied, 1);
	assert.equal(
		readRecord(db, { ...readCommon, recordId: record.recordId }).status,
		"forgotten",
	);
	assert.equal(listState(db, readCommon).items.length, 0);
	assert.equal(
		write(() =>
			reconcileForgetJournal(db, {
				contractVersion: 1,
				entries: journal,
				clock: { atMs: 300 },
			}),
		).reapplied,
		0,
	);
	assert.equal(
		write(() =>
			reconcileForgetJournal(db, {
				contractVersion: 1,
				entries: [],
				clock: { atMs: 300 },
			}),
		).status,
		"inconsistent",
	);
	assert.equal(
		write(() => captureRecord(db, capture)).reasonCode,
		"TOMBSTONED",
	);
	checks.push("restore replay idempotence truncated journal and tombstone");
	// 契約版 2: hostIntent を鎖に載せた entry（ホストは JSON 行として保存し、読み戻して渡す）。
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	copyFileSync(join(dir, "before.db"), join(dir, "before-intent.db"));
	const intentPlan = planForget(db, {
		contractVersion: 2,
		access,
		hostIntent: { messageIds: ["m:2", "m:1", "m:2"] },
		clock: { atMs: 400 },
	});
	assert.equal(intentPlan.status, "planned");
	assert.equal(intentPlan.plan.entry.journalFormat, 2);
	assert.deepEqual(intentPlan.plan.entry.targets, []);
	const intentJournal = [
		...journal,
		JSON.parse(JSON.stringify(intentPlan.plan.entry)),
	];
	assert.equal(verifyForgetJournal(intentJournal).status, "ok");
	write(() =>
		applyForget(db, {
			contractVersion: 2,
			entry: intentJournal[1],
			clock: { atMs: 400 },
		}),
	);
	native.close();
	native = new DatabaseSync(join(dir, "before-intent.db"));
	const intentRecovered = write(() =>
		reconcileForgetJournal(db, {
			contractVersion: 2,
			entries: intentJournal,
			clock: { atMs: 500 },
		}),
	);
	assert.equal(intentRecovered.status, "ok");
	assert.equal(intentRecovered.reapplied, 1);
	assert.deepEqual(
		JSON.parse(JSON.stringify(intentRecovered.hostIntentsToReapply)),
		[
			{
				forgetId: intentPlan.plan.entry.forgetId,
				hostIntent: { messageIds: ["m:1", "m:2"] },
			},
		],
	);
	const tamperedJournal = [
		journal[0],
		{ ...intentJournal[1], hostIntent: { messageIds: ["m:9"] } },
	];
	assert.equal(verifyForgetJournal(tamperedJournal).status, "inconsistent");
	checks.push("host intent journal format 2 and restore");
	// inTransaction を持たない接続への書き込みは、検査を省かずに拒否する。
	const bare = { exec: db.exec, query: db.query };
	assert.throws(
		() => captureRecord(bare, capture),
		(error) => error?.code === "NOT_IN_TRANSACTION",
	);
	checks.push("missing inTransaction rejected");
	console.log(
		JSON.stringify({
			status: "passed",
			runtime: process.versions.bun
				? `Bun ${process.versions.bun}`
				: process.version,
			contracts: CONTRACT_VERSIONS,
			checks,
		}),
	);
} finally {
	native.close();
	rmSync(dir, { recursive: true, force: true });
}
