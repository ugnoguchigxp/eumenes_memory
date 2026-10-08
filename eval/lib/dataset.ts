/**
 * 評価データ（JSONL）の読み込みと厳密な検査、gold → モデル出力形式への変換（oracle 用）。
 * 時刻・乱数・ネットワークを使わない。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	LIMITS_EXTRACTION,
	MODALITIES,
	POLARITIES,
	SOURCE_ROLES,
	STATE_KINDS,
	TEMPORALS,
} from "eumenes-memory";
import type { ExtractionOutput } from "eumenes-memory";
import { ATTRIBUTES, CATEGORIES, SPLITS, SUBJECT_CLASSES } from "./types.ts";
import type {
	Acceptable,
	Category,
	EvalCase,
	EvalSource,
	GoldCandidate,
	GoldSpan,
} from "./types.ts";

export const DATASET_ID = "ja-memory-v1";
export const DATASET_PATH = join(
	import.meta.dir,
	"..",
	"datasets",
	`${DATASET_ID}.jsonl`,
);

const encoder = new TextEncoder();

export interface ByteSpan {
	readonly source: number;
	readonly startByte: number;
	readonly endByte: number;
	readonly quote: string;
}

function fail(id: string, message: string): never {
	throw new Error(`dataset case ${id}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
	id: string,
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): void {
	for (const key of required) {
		if (!Object.hasOwn(value, key)) fail(id, `missing key ${key}`);
	}
	for (const key of Object.keys(value)) {
		if (!required.includes(key) && !optional.includes(key)) {
			fail(id, `unknown key ${key}`);
		}
	}
}

function oneOf<T extends string>(
	id: string,
	label: string,
	value: unknown,
	allowed: readonly T[],
): T {
	for (const candidate of allowed) {
		if (candidate === value) return candidate;
	}
	return fail(id, `${label} must be one of ${allowed.join("|")}`);
}

function readString(id: string, label: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		fail(id, `${label} must be a non-empty string`);
	}
	return value;
}

function readSpan(
	id: string,
	value: unknown,
	sources: readonly EvalSource[],
): GoldSpan {
	if (!isRecord(value)) return fail(id, "span must be an object");
	exactKeys(id, value, ["source", "quote"], []);
	const source = value["source"];
	if (
		typeof source !== "number" ||
		!Number.isInteger(source) ||
		source < 0 ||
		source >= sources.length
	) {
		fail(id, "span.source out of range");
	}
	const quote = readString(id, "span.quote", value["quote"]);
	const content = sources[source as number]?.content ?? "";
	const first = content.indexOf(quote);
	if (first < 0) fail(id, `quote not in source: ${quote}`);
	if (content.indexOf(quote, first + 1) >= 0) {
		fail(id, `quote is not unique in source: ${quote}`);
	}
	return { source: source as number, quote };
}

function readAcceptable(id: string, value: unknown): Acceptable {
	if (!isRecord(value)) return fail(id, "acceptable must be an object");
	exactKeys(id, value, [], ATTRIBUTES);
	const result: Record<string, readonly string[]> = {};
	const enums: Record<string, readonly string[]> = {
		kind: STATE_KINDS,
		subject: SUBJECT_CLASSES,
		polarity: POLARITIES,
		modality: MODALITIES,
		temporal: TEMPORALS,
	};
	for (const attribute of ATTRIBUTES) {
		const list = value[attribute];
		if (list === undefined) continue;
		if (!Array.isArray(list) || list.length === 0) {
			fail(id, `acceptable.${attribute} must be a non-empty array`);
		}
		const allowed = enums[attribute] ?? [];
		result[attribute] = list.map((item: unknown) =>
			oneOf(id, `acceptable.${attribute}`, item, allowed),
		);
	}
	return result;
}

function readGold(
	id: string,
	value: unknown,
	sources: readonly EvalSource[],
): GoldCandidate {
	if (!isRecord(value)) return fail(id, "gold candidate must be an object");
	exactKeys(
		id,
		value,
		[
			"kind",
			"subject",
			"polarity",
			"modality",
			"temporal",
			"spans",
			"valueHint",
		],
		["acceptable"],
	);
	const spans = value["spans"];
	if (!Array.isArray(spans) || spans.length === 0 || spans.length > 4) {
		fail(id, "spans must have 1..4 entries");
	}
	const candidate: GoldCandidate = {
		kind: oneOf(id, "kind", value["kind"], STATE_KINDS),
		subject: oneOf(id, "subject", value["subject"], SUBJECT_CLASSES),
		polarity: oneOf(id, "polarity", value["polarity"], POLARITIES),
		modality: oneOf(id, "modality", value["modality"], MODALITIES),
		temporal: oneOf(id, "temporal", value["temporal"], TEMPORALS),
		spans: spans.map((span: unknown) => readSpan(id, span, sources)),
		valueHint: readString(id, "valueHint", value["valueHint"]),
	};
	return Object.hasOwn(value, "acceptable")
		? { ...candidate, acceptable: readAcceptable(id, value["acceptable"]) }
		: candidate;
}

/** 1 ケースを厳密に検査して型付きで返す（不正なら例外）。 */
export function parseCase(raw: unknown): EvalCase {
	if (!isRecord(raw)) throw new Error("dataset line must be an object");
	const id = readString("?", "id", raw["id"]);
	exactKeys(
		id,
		raw,
		["id", "category", "split", "humanReviewed", "sources", "expect", "note"],
		["acceptNoChange", "tolerated"],
	);
	const category: Category = oneOf(id, "category", raw["category"], CATEGORIES);
	const split = oneOf(id, "split", raw["split"], SPLITS);
	if (typeof raw["humanReviewed"] !== "boolean") {
		fail(id, "humanReviewed must be boolean");
	}
	const rawSources = raw["sources"];
	if (
		!Array.isArray(rawSources) ||
		rawSources.length === 0 ||
		rawSources.length > 8
	) {
		return fail(id, "sources must have 1..8 entries");
	}
	const sources: EvalSource[] = rawSources.map((entry: unknown) => {
		if (!isRecord(entry)) return fail(id, "source must be an object");
		exactKeys(id, entry, ["role", "content"], []);
		return {
			role: oneOf(id, "source.role", entry["role"], SOURCE_ROLES),
			content: readString(id, "source.content", entry["content"]),
		};
	});
	const expect = raw["expect"];
	if (!isRecord(expect)) return fail(id, "expect must be an object");
	exactKeys(id, expect, ["noChange", "candidates"], []);
	if (typeof expect["noChange"] !== "boolean") {
		fail(id, "expect.noChange must be boolean");
	}
	const rawCandidates = expect["candidates"];
	if (
		!Array.isArray(rawCandidates) ||
		rawCandidates.length > LIMITS_EXTRACTION.maxCandidates
	) {
		return fail(id, "expect.candidates must be an array within the limit");
	}
	if (expect["noChange"] !== (rawCandidates.length === 0)) {
		fail(id, "expect.noChange must equal (candidates is empty)");
	}
	let acceptNoChange: boolean | undefined;
	if (Object.hasOwn(raw, "acceptNoChange")) {
		if (typeof raw["acceptNoChange"] !== "boolean") {
			fail(id, "acceptNoChange must be boolean");
		}
		acceptNoChange = raw["acceptNoChange"];
	}
	let tolerated: readonly GoldSpan[] | undefined;
	if (Object.hasOwn(raw, "tolerated")) {
		const list = raw["tolerated"];
		if (!Array.isArray(list)) return fail(id, "tolerated must be an array");
		tolerated = list.map((span: unknown) => readSpan(id, span, sources));
	}
	return {
		id,
		category,
		split,
		humanReviewed: raw["humanReviewed"],
		sources,
		expect: {
			noChange: expect["noChange"],
			candidates: rawCandidates.map((candidate: unknown) =>
				readGold(id, candidate, sources),
			),
		},
		...(acceptNoChange === undefined ? {} : { acceptNoChange }),
		...(tolerated === undefined ? {} : { tolerated }),
		note: readString(id, "note", raw["note"]),
	};
}

/** JSONL の本文を検査して読む。id の重複は例外。 */
export function parseDataset(text: string): readonly EvalCase[] {
	const cases: EvalCase[] = [];
	const seen = new Set<string>();
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			throw new Error(`dataset line ${index + 1} is not valid JSON`);
		}
		const parsed = parseCase(raw);
		if (seen.has(parsed.id)) {
			throw new Error(`dataset case ${parsed.id}: duplicate id`);
		}
		seen.add(parsed.id);
		cases.push(parsed);
	}
	return cases;
}

export function loadDataset(path: string = DATASET_PATH): readonly EvalCase[] {
	return parseDataset(readFileSync(path, "utf8"));
}

/** gold の span を、本文の UTF-8 byte 範囲にする。 */
export function spanToBytes(
	sources: readonly EvalSource[],
	span: GoldSpan,
): ByteSpan {
	const content = sources[span.source]?.content ?? "";
	const at = content.indexOf(span.quote);
	const startByte = encoder.encode(content.slice(0, at)).length;
	return {
		source: span.source,
		startByte,
		endByte: startByte + encoder.encode(span.quote).length,
		quote: span.quote,
	};
}

/** 入力の出典（role + content の並び）から、データセットの 1 ケースを引く。oracle 用。 */
export function sourcesSignature(
	sources: readonly { readonly role: string; readonly content: string }[],
): string {
	return JSON.stringify(sources.map((s) => [s.role, s.content]));
}

export function indexBySources(
	cases: readonly EvalCase[],
): ReadonlyMap<string, EvalCase> {
	const map = new Map<string, EvalCase>();
	for (const evalCase of cases) {
		map.set(sourcesSignature(evalCase.sources), evalCase);
	}
	return map;
}

/** gold をそのまま ExtractionOutput にする（oracle 用）。 */
export function goldToOutput(evalCase: EvalCase): ExtractionOutput {
	if (evalCase.expect.noChange) return { noChange: true, candidates: [] };
	return {
		noChange: false,
		candidates: evalCase.expect.candidates.map((gold, index) => ({
			kind: gold.subject === "other" ? "other_person_note" : gold.kind,
			subject:
				gold.subject === "other"
					? "other:person"
					: gold.subject === "self"
						? "self"
						: "unknown",
			semanticKey: `eval.${evalCase.id}.${index}`,
			value: { text: gold.valueHint, polarity: gold.polarity },
			modality: gold.modality,
			temporal: gold.temporal,
			evidence: gold.spans.map((span) => {
				const bytes = spanToBytes(evalCase.sources, span);
				return {
					sourceIndex: bytes.source,
					startByte: bytes.startByte,
					endByte: bytes.endByte,
					quote: bytes.quote,
				};
			}),
		})),
	};
}
