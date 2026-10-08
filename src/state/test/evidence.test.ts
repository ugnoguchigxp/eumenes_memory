import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../../canonical/sha256.ts";
import type { EvidenceSpan } from "../../contracts/common.ts";
import type { HostSourceState } from "../../contracts/state.ts";
import {
	checkEvidence,
	evidenceOrdinalOf,
	isQuotedSpan,
	quoteMatches,
} from "../evidence.ts";

function source(id: string, content: string, ordinal = 1): HostSourceState {
	const digest = sha256Hex(content);
	return {
		namespace: "conversation",
		kind: "message",
		id,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: "p",
		scopeKey: "s",
		status: "available",
		content,
		ordinal,
	};
}

function span(
	src: HostSourceState,
	quote: string,
	startByte?: number,
): EvidenceSpan {
	const start =
		startByte ??
		Buffer.byteLength(src.content.slice(0, src.content.indexOf(quote)), "utf8");
	return {
		source: {
			namespace: src.namespace,
			kind: src.kind,
			id: src.id,
			representation: "text",
			revision: src.revision,
			digest: src.digest,
			range: {
				startByte: start,
				endByte: start + Buffer.byteLength(quote, "utf8"),
			},
		},
		quote,
	};
}

const check = (
	evidence: EvidenceSpan[],
	inputs: HostSourceState[],
	current: HostSourceState[] = inputs,
) =>
	checkEvidence({
		principal: "p",
		scopeKey: "s",
		evidence,
		inputSources: inputs,
		currentSources: current,
	});

describe("quoteMatches", () => {
	const m = source("m", "A😀B私");
	test("exact bytes match, boundaries and bounds are enforced", () => {
		expect(quoteMatches(m.content, span(m, "😀"))).toBe(true);
		expect(quoteMatches(m.content, span(m, "😀", 2))).toBe(false); // 絵文字の途中
		expect(quoteMatches(m.content, span(m, "私", 6))).toBe(true);
		expect(quoteMatches(m.content, span(m, "私", 100))).toBe(false);
		expect(quoteMatches(m.content, { ...span(m, "私"), quote: "" })).toBe(
			false,
		);
		const noRange = {
			source: { ...span(m, "私").source, range: undefined },
			quote: "私",
		} as unknown as EvidenceSpan;
		expect(quoteMatches(m.content, noRange)).toBe(false);
	});
});

describe("checkEvidence order and rules", () => {
	const m = source("m", "私はコーヒーが好き");
	test("passes for a faithful span", () => {
		expect(check([span(m, "コーヒー")], [m])).toBeNull();
	});
	test("quote mismatch wins over a missing second source", () => {
		const bad = { ...span(m, "コーヒー"), quote: "紅茶" };
		expect(check([bad, span(source("x", "y"), "y")], [m])).toBe(
			"QUOTE_MISMATCH",
		);
	});
	test("wrong scope or principal means not in input", () => {
		expect(check([span(m, "コーヒー")], [{ ...m, scopeKey: "other" }])).toBe(
			"EVIDENCE_NOT_IN_INPUT",
		);
		expect(check([span(m, "コーヒー")], [{ ...m, principal: "q" }])).toBe(
			"EVIDENCE_NOT_IN_INPUT",
		);
	});
	test("non-available or changed current state is stale; a body that does not hash to its digest is stale", () => {
		expect(
			check([span(m, "コーヒー")], [m], [{ ...m, status: "forgotten" }]),
		).toBe("SOURCE_STALE");
		expect(
			check([span(m, "コーヒー")], [m], [{ ...m, digest: sha256Hex("x") }]),
		).toBe("SOURCE_STALE");
		expect(check([span(m, "コーヒー")], [m], [])).toBe("SOURCE_STALE");
		expect(
			check([span(m, "コーヒー")], [{ ...m, content: m.content + "!" }]),
		).toBe("SOURCE_STALE");
	});
	test("evidence ordinal is the maximum of the matched input sources", () => {
		const a = source("a", "aaa", 2);
		const b = source("b", "bbb", 9);
		const base = { principal: "p", scopeKey: "s", inputSources: [a, b] };
		expect(
			evidenceOrdinalOf({
				...base,
				evidence: [span(a, "aaa"), span(b, "bbb")],
			}),
		).toBe(9);
		expect(
			evidenceOrdinalOf({
				...base,
				evidence: [span(a, "aaa"), span(source("c", "c"), "c")],
			}),
		).toBeNull();
	});
});

describe("isQuotedSpan", () => {
	test.each([
		["母は「私はコーヒー」と言った", "私はコーヒー", true],
		["母は『私はコーヒー』と言った", "私はコーヒー", true],
		["母は“I like coffee”と言った", "I like coffee", true],
		['He said "I like coffee" ok', "I like coffee", true],
		["「閉じた」あと私はコーヒー", "私はコーヒー", false],
		["私はコーヒーが好き", "私はコーヒー", false],
		["私は「コーヒーが好き」", "「コーヒーが好き」", true],
		['He said "x" then I like coffee', "I like coffee", false],
		// quote 自身が両端を ASCII の二重引用符で囲む（range の開始位置の手前に未閉じの引用符はない）
		['He said "I like coffee" ok', '"I like coffee"', true],
		// 1 文字だけの " は囲みではない
		['a " b', '"', false],
		["私は『コーヒー』が好き", "『コーヒー』", true],
		["私は“コーヒー”が好き", "“コーヒー”", true],
		// 開きと閉じが対応しない
		["私は「コーヒー』が好き", "「コーヒー』", false],
		["私は「コーヒー”が好き", "「コーヒー”", false],
	])("%s / %s", (content, quote, expected) => {
		const m = source("m", content);
		expect(isQuotedSpan(content, span(m, quote))).toBe(expected);
	});
});
