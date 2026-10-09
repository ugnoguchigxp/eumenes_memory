import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../../../canonical/sha256.ts";
import {
	contentRevision,
	isRecordId,
	recordIdOf,
	recordSourceKey,
	recordSourceRef,
} from "../service/identity.ts";
import { sliceUtf8Range } from "../service/range.ts";

describe("record identity", () => {
	test("recordId depends on principal, scope and origin only", () => {
		const origin = { namespace: "web", kind: "page", id: "u" };
		const id = recordIdOf("p", "s", origin);
		expect(isRecordId(id)).toBe(true);
		expect(recordIdOf("p", "s", { ...origin })).toBe(id);
		expect(recordIdOf("q", "s", origin)).not.toBe(id);
		expect(recordIdOf("p", "t", origin)).not.toBe(id);
		expect(recordIdOf("p", "s", { ...origin, id: "v" })).not.toBe(id);
		expect(isRecordId("rec:xyz")).toBe(false);
	});

	test("revision / digest / source key", () => {
		const { revision, digest } = contentRevision("食べ物");
		expect(digest).toBe(sha256Hex(new TextEncoder().encode("食べ物")));
		expect(revision).toBe(`sha256:${digest}`);
		const id = recordIdOf("p", "s", { namespace: "a", kind: "b", id: "c" });
		expect(recordSourceKey(id)).toBe(
			JSON.stringify(["memory", "record", id, "text"]),
		);
		expect(
			recordSourceRef(id, revision, digest, { startByte: 0, endByte: 3 }),
		).toEqual({
			namespace: "memory",
			kind: "record",
			id,
			representation: "text",
			revision,
			digest,
			range: { startByte: 0, endByte: 3 },
		});
	});
});

describe("sliceUtf8Range", () => {
	test("returns text and the digest of the raw bytes", () => {
		const slice = sliceUtf8Range("ab食c", { startByte: 2, endByte: 5 });
		expect(slice).toEqual({
			status: "ok",
			text: "食",
			digest: sha256Hex(new TextEncoder().encode("食")),
		});
	});
	test("reason codes", () => {
		expect(sliceUtf8Range("ab食c", { startByte: 2, endByte: 4 })).toEqual({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_NOT_CHAR_BOUNDARY",
		});
		expect(sliceUtf8Range("ab", { startByte: 0, endByte: 3 })).toEqual({
			status: "invalid_range",
			reasonCode: "SOURCE_RANGE_OUT_OF_BOUNDS",
		});
		expect(
			sliceUtf8Range("a".repeat(70000), { startByte: 0, endByte: 65537 }),
		).toEqual({ status: "invalid_range", reasonCode: "RANGE_TOO_LARGE" });
		expect(
			sliceUtf8Range("a".repeat(70000), { startByte: 0, endByte: 65536 })
				.status,
		).toBe("ok");
	});
});
