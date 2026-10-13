import { afterEach, expect, test } from "bun:test";
import {
	retainRecord,
	readRetainedRecord,
	useRetainedRecord,
	retainedRecordStats,
	evictRetainedRecords,
	registerExternalDependents,
	planForget,
	applyForget,
	captureRecord,
	readRecord,
} from "eumenes-memory/sqlite";
import { openTestStore, type TestStore } from "../support/store.ts";

let store: TestStore;
afterEach(() => store?.close());
const access = {
	principal: "owner",
	scopeKeys: ["research"],
	purpose: "research.read",
	policyRevision: "1",
};
const common = {
	contractVersion: 1 as const,
	access,
	scopeKey: "research",
	clock: { atMs: 100 },
};
function capture(text = "original", now = 100, fresh = 500) {
	return store.write((db) =>
		retainRecord(db, {
			record: {
				...common,
				clock: { atMs: now },
				origin: { namespace: "web", kind: "document", id: "url-key" },
				mediaType: "text/markdown",
				content: text,
				captureState: "complete",
			},
			freshUntilMs: fresh,
			idleTtlMs: 200,
		}),
	);
}
function available(now: number, id: string) {
	return store.read((db) =>
		readRetainedRecord(db, { ...common, clock: { atMs: now }, recordId: id }),
	);
}

test("read does not touch; adoption extends only idle; expiry boundaries miss", () => {
	store = openTestStore();
	const result = capture();
	if (result.status !== "captured") throw new Error("capture failed");
	const hit = available(250, result.recordId);
	expect(hit.status).toBe("available");
	expect(available(300, result.recordId).status).toBe("miss");
	if (hit.status !== "available") throw new Error("missing");
	expect(
		store.write((db) =>
			useRetainedRecord(db, {
				...common,
				clock: { atMs: 290 },
				recordId: result.recordId,
				retentionRevision: hit.retentionRevision,
			}),
		),
	).toBe(true);
	const after = available(350, result.recordId);
	if (after.status !== "available") throw new Error("missing");
	expect(after.freshUntilMs).toBe(500);
	expect(after.idleExpiresAtMs).toBe(490);
	expect(available(500, result.recordId).status).toBe("miss");
});

test("replacement prunes past revisions and rejects the old adoption receipt", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("missing");
	const hit = available(120, first.recordId);
	if (hit.status !== "available") throw new Error("missing");
	capture("new", 130);
	expect(
		store.write((db) =>
			useRetainedRecord(db, {
				...common,
				clock: { atMs: 150 },
				recordId: first.recordId,
				retentionRevision: hit.retentionRevision,
			}),
		),
	).toBe(false);
	expect(
		store.read((db) =>
			readRecord(db, {
				contractVersion: 1,
				access,
				scopeKey: "research",
				recordId: first.recordId,
				revision: first.revision,
			}),
		).status,
	).toBe("missing");
	expect(store.read((db) => retainedRecordStats(db, common))).toEqual({
		entries: 1,
		bytes: 3,
	});
});

test("expiry evicts all bodies and indexes, but explicit recapture is allowed", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("missing");
	expect(
		store.write((db) =>
			evictRetainedRecords(db, { ...common, clock: { atMs: 300 }, limit: 100 }),
		),
	).toEqual({ deleted: [first.recordId], blocked: [] });
	expect(store.read((db) => retainedRecordStats(db, common))).toEqual({
		entries: 0,
		bytes: 0,
	});
	expect(
		store.reader.query("SELECT count(*) AS n FROM memory_record_fts").get(),
	).toEqual({ n: 0 });
	expect(capture("again", 400, 600).status).toBe("captured");
});

test("unauthorized reads and eviction do not expose or erase another scope", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("missing");
	const denied = { ...common, access: { ...access, scopeKeys: [] } };
	expect(
		store.read((db) =>
			readRetainedRecord(db, { ...denied, recordId: first.recordId }),
		).status,
	).toBe("miss");
	expect(
		store.write((db) =>
			evictRetainedRecords(db, { ...denied, oldest: true, limit: 100 }),
		).deleted,
	).toEqual([]);
	expect(available(150, first.recordId).status).toBe("available");
});

test("ordinary durable Records never acquire idle deletion implicitly", () => {
	store = openTestStore();
	const input = {
		...common,
		origin: { namespace: "web", kind: "document", id: "durable" },
		mediaType: "text/plain" as const,
		content: "durable",
		captureState: "complete" as const,
	};
	const first = store.write((db) => captureRecord(db, input));
	if (first.status !== "captured") throw new Error("missing");
	expect(
		store.write((db) =>
			evictRetainedRecords(db, {
				...common,
				clock: { atMs: 9999 },
				oldest: true,
				limit: 100,
			}),
		).deleted,
	).toEqual([]);
	expect(
		store.read((db) =>
			readRecord(db, {
				contractVersion: 1,
				access,
				scopeKey: "research",
				recordId: first.recordId,
			}),
		).status,
	).toBe("available");
	expect(() =>
		store.write((db) =>
			retainRecord(db, { record: input, freshUntilMs: 500, idleTtlMs: 200 }),
		),
	).toThrow();
});

test("retention refresh cannot prune revisions used by a durable dependent", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("capture failed");
	store.write((db) =>
		registerExternalDependents(db, {
			...common,
			dependents: [
				{
					providerRef: "fixture",
					externalId: "durable-report",
					dependsOn: [
						{
							type: "source",
							id: JSON.stringify([
								first.ref.namespace,
								first.ref.kind,
								first.ref.id,
								first.ref.representation ?? null,
							]),
						},
					],
				},
			],
		}),
	);
	expect(() => capture("replacement", 150, 600)).toThrow();
	const current = available(150, first.recordId);
	if (current.status !== "available") throw new Error("missing source");
	expect(current.record.content).toBe("original");
});

test("retention creation refuses an unauthorized scope before inspecting whether a durable record exists", () => {
	store = openTestStore();
	const record = {
		...common,
		origin: { namespace: "web", kind: "document", id: "durable" },
		mediaType: "text/plain" as const,
		content: "durable",
		captureState: "complete" as const,
	};
	store.write((db) => captureRecord(db, record));
	const denied = { ...record, access: { ...access, scopeKeys: [] } };
	expect(
		store.write((db) =>
			retainRecord(db, { record: denied, freshUntilMs: 500, idleTtlMs: 200 }),
		),
	).toEqual({ status: "blocked", reasonCode: "SCOPE_NOT_PERMITTED" });
});

test("forget removes retention metadata and eviction cannot resurrect the tombstoned source", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("capture failed");
	const planned = store.read((db) =>
		planForget(db, {
			contractVersion: 1,
			access,
			target: {
				type: "record",
				scopeKey: "research",
				recordId: first.recordId,
			},
			clock: { atMs: 120 },
		}),
	);
	if (planned.status !== "planned") throw new Error("forget denied");
	store.write((db) =>
		applyForget(db, {
			contractVersion: 1,
			entry: planned.plan.entry,
			clock: { atMs: 120 },
		}),
	);
	expect(store.read((db) => retainedRecordStats(db, common))).toEqual({
		entries: 0,
		bytes: 0,
	});
	store.write((db) =>
		evictRetainedRecords(db, { ...common, oldest: true, limit: 100 }),
	);
	expect(capture("should not return", 150, 600)).toMatchObject({
		status: "blocked",
		reasonCode: "TOMBSTONED",
	});
});

test("retention input parsing rejects unknown keys and accessors without invoking them", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("capture failed");
	const input = { ...common, recordId: first.recordId, unknown: true };
	expect(() => store.read((db) => readRetainedRecord(db, input))).toThrow();
	let invoked = 0;
	const accessor = { ...common, recordId: first.recordId };
	Object.defineProperty(accessor, "clock", {
		get() {
			invoked++;
			return { atMs: 150 };
		},
	});
	expect(() => store.read((db) => readRetainedRecord(db, accessor))).toThrow();
	expect(invoked).toBe(0);
});

test("targeted eviction removes only the requested owned record", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("capture failed");
	const second = store.write((db) =>
		retainRecord(db, {
			record: {
				...common,
				origin: { namespace: "web", kind: "document", id: "other" },
				mediaType: "text/plain",
				content: "other source",
				captureState: "complete",
			},
			freshUntilMs: 500,
			idleTtlMs: 200,
		}),
	);
	if (second.status !== "captured") throw new Error("capture failed");
	expect(
		store.write((db) =>
			evictRetainedRecords(db, {
				...common,
				limit: 1,
				oldest: true,
				recordId: second.recordId,
			}),
		),
	).toEqual({ deleted: [second.recordId], blocked: [] });
	expect(available(150, first.recordId).status).toBe("available");
});

test("external provider exports protect retained bodies from pruning and eviction", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("capture failed");
	store.write((db) =>
		captureRecord(db, {
			...common,
			origin: { namespace: "web", kind: "document", id: "url-key" },
			mediaType: "text/markdown",
			content: "original",
			captureState: "complete",
			providerRef: "provider-receipt",
		}),
	);
	expect(() => capture("new body", 150, 600)).toThrow();
	expect(
		store.write((db) =>
			evictRetainedRecords(db, { ...common, oldest: true, limit: 1 }),
		),
	).toEqual({ deleted: [], blocked: [first.recordId] });
	expect(available(150, first.recordId).status).toBe("available");
});

test("a protected oldest source does not starve eviction of other disposable records", () => {
	store = openTestStore();
	const first = capture();
	if (first.status !== "captured") throw new Error("capture failed");
	store.write((db) =>
		registerExternalDependents(db, {
			...common,
			dependents: [
				{
					providerRef: "fixture",
					externalId: "report",
					dependsOn: [
						{
							type: "source",
							id: JSON.stringify([
								first.ref.namespace,
								first.ref.kind,
								first.ref.id,
								first.ref.representation ?? null,
							]),
						},
					],
				},
			],
		}),
	);
	const second = store.write((db) =>
		retainRecord(db, {
			record: {
				...common,
				origin: { namespace: "web", kind: "document", id: "disposable" },
				mediaType: "text/plain",
				content: "disposable source",
				captureState: "complete",
			},
			freshUntilMs: 500,
			idleTtlMs: 200,
		}),
	);
	if (second.status !== "captured") throw new Error("capture failed");
	expect(
		store.write((db) =>
			evictRetainedRecords(db, { ...common, oldest: true, limit: 1 }),
		),
	).toEqual({ deleted: [second.recordId], blocked: [] });
});
