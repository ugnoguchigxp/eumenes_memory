/**
 * モデル出力（`ExtractorPort` の戻り値）の厳密 parse。純粋。契約は `src/contracts/extraction.ts`、設計は §3.6。
 *
 * 判定の順序（最初に当たったものが run 全体の `rejected_output`）:
 * 1. JSON として扱えない値（関数・undefined・null・小数・非 plain object・getter・循環・深すぎる入れ子）→ `OUTPUT_SCHEMA`
 * 2. 値の個数が上限超過、または canonical JSON が 16 KiB 超 → `OUTPUT_TOO_LARGE`
 * 3. トップレベルの形（キーは `noChange` と `candidates` だけ、型）→ `OUTPUT_SCHEMA`
 * 4. 候補が 10 件超 → `TOO_MANY_CANDIDATES`
 * 5. `noChange` と `candidates` の空が一致しない → `OUTPUT_SCHEMA`（`noChange === true` ⇔ 候補が空）
 * 6. 各候補の形（未知のキー＝`scope` / `confidence` / `status` / `origin` などの権限系を含む、型）→ `OUTPUT_SCHEMA`
 *
 * 候補の「値」の不正（未知の kind、enum 外の modality、空の semanticKey、evidence の個数、範囲外の quote など）は
 * ここでは見ない。run を落とさず、Admission が候補単位で `rejected` にする（kind / subject / enum は文字列のまま通す）。
 * 同じ output（canonical JSON が同じ）は同じ digest を持つ（冪等判定に使う）。
 */
import { canonicalJson } from "../canonical/json.ts";
import { sha256Hex } from "../canonical/sha256.ts";
import { utf8ByteLength } from "../canonical/utf8.ts";
import type {
	ExtractionOutput,
	ExtractionOutputCandidate,
	ExtractionOutputEvidence,
	ExtractionRejectedOutputReasonCode,
} from "../contracts/extraction.ts";
import { LIMITS_EXTRACTION } from "../contracts/extraction.ts";
import type {
	Modality,
	Polarity,
	Subject,
	Temporal,
} from "../contracts/common.ts";

/** 入れ子の深さの上限（schema の最大は 5 段）。 */
const MAX_DEPTH = 8;
/** 走査する値の個数の上限。巨大な配列で canonical 化に時間を使わないため（超えたら OUTPUT_TOO_LARGE）。 */
const MAX_NODES = 4096;

export type ParsedExtractionOutput =
	| {
			readonly ok: true;
			readonly output: ExtractionOutput;
			/** canonical JSON の SHA-256 hex。 */
			readonly digest: string;
	  }
	| {
			readonly ok: false;
			readonly reasonCode: ExtractionRejectedOutputReasonCode;
			/** canonical 化できた場合だけ。できなければ null。 */
			readonly digest: string | null;
	  };

type Plain = string | boolean | number | readonly Plain[] | PlainRecord;
interface PlainRecord {
	readonly [key: string]: Plain;
}

class Rejected extends Error {
	readonly reasonCode: ExtractionRejectedOutputReasonCode;
	constructor(reasonCode: ExtractionRejectedOutputReasonCode) {
		super(reasonCode);
		this.reasonCode = reasonCode;
	}
}

function schema(): never {
	throw new Rejected("OUTPUT_SCHEMA");
}

/** own のデータプロパティだけを読み、plain なコピーを作る（JSON として扱える値以外は OUTPUT_SCHEMA）。 */
function plainCopy(
	value: unknown,
	depth: number,
	budget: { remaining: number },
): Plain {
	budget.remaining -= 1;
	if (budget.remaining < 0) throw new Rejected("OUTPUT_TOO_LARGE");
	if (depth > MAX_DEPTH) return schema();
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		return Number.isSafeInteger(value) ? (value === 0 ? 0 : value) : schema();
	}
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1) return schema();
		const copy: Plain[] = [];
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
				return schema();
			}
			copy.push(plainCopy(descriptor.value, depth + 1, budget));
		}
		return copy;
	}
	if (typeof value === "object" && value !== null) {
		const proto: unknown = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return schema();
		const copy: Record<string, Plain> = Object.create(null);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol") return schema();
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
				return schema();
			}
			copy[key] = plainCopy(descriptor.value, depth + 1, budget);
		}
		return copy;
	}
	return schema();
}

function isRecord(value: Plain): value is PlainRecord {
	return typeof value === "object" && !Array.isArray(value);
}

function isArray(value: Plain): value is readonly Plain[] {
	return Array.isArray(value);
}

function exactKeys(
	record: PlainRecord,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	for (const key of Object.keys(record)) {
		if (!required.includes(key) && !optional.includes(key)) schema();
	}
	for (const key of required) {
		if (!Object.hasOwn(record, key)) schema();
	}
}

function readString(record: PlainRecord, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : schema();
}

function readInteger(record: PlainRecord, key: string): number {
	const value = record[key];
	return typeof value === "number" ? value : schema();
}

function readEvidence(value: Plain): ExtractionOutputEvidence {
	if (!isRecord(value)) return schema();
	exactKeys(value, ["sourceIndex", "startByte", "endByte", "quote"]);
	return {
		sourceIndex: readInteger(value, "sourceIndex"),
		startByte: readInteger(value, "startByte"),
		endByte: readInteger(value, "endByte"),
		quote: readString(value, "quote"),
	};
}

function readCandidate(value: Plain): ExtractionOutputCandidate {
	if (!isRecord(value)) return schema();
	exactKeys(
		value,
		[
			"kind",
			"subject",
			"semanticKey",
			"value",
			"modality",
			"temporal",
			"evidence",
		],
		["replaces"],
	);
	const inner = value["value"];
	if (inner === undefined || !isRecord(inner)) return schema();
	exactKeys(inner, ["text", "polarity"]);
	const evidence = value["evidence"];
	if (evidence === undefined || !isArray(evidence)) return schema();
	const candidate: ExtractionOutputCandidate = {
		// enum / 形式の検査は Admission（候補単位）。ここでは文字列であることだけを見る。
		kind: readString(value, "kind"),
		subject: readString(value, "subject") as Subject,
		semanticKey: readString(value, "semanticKey"),
		value: {
			text: readString(inner, "text"),
			polarity: readString(inner, "polarity") as Polarity,
		},
		modality: readString(value, "modality") as Modality,
		temporal: readString(value, "temporal") as Temporal,
		evidence: evidence.map(readEvidence),
	};
	return Object.hasOwn(value, "replaces")
		? { ...candidate, replaces: readString(value, "replaces") }
		: candidate;
}

/** canonical JSON から digest（と byte 長）を求める。canonical 化できない値は null。 */
export function digestOutput(
	output: unknown,
): { readonly digest: string; readonly bytes: number } | null {
	try {
		const plain = plainCopy(output, 0, { remaining: MAX_NODES });
		const canonical = canonicalJson(plain);
		return { digest: sha256Hex(canonical), bytes: utf8ByteLength(canonical) };
	} catch {
		return null;
	}
}

export function parseExtractionOutput(output: unknown): ParsedExtractionOutput {
	let digest: string | null = null;
	try {
		const plain = plainCopy(output, 0, { remaining: MAX_NODES });
		const canonical = canonicalJson(plain);
		digest = sha256Hex(canonical);
		if (utf8ByteLength(canonical) > LIMITS_EXTRACTION.maxOutputBytes) {
			throw new Rejected("OUTPUT_TOO_LARGE");
		}
		if (!isRecord(plain)) return schema();
		exactKeys(plain, ["noChange", "candidates"]);
		const noChange = plain["noChange"];
		const candidates = plain["candidates"];
		if (typeof noChange !== "boolean") return schema();
		if (candidates === undefined || !isArray(candidates)) return schema();
		if (candidates.length > LIMITS_EXTRACTION.maxCandidates) {
			throw new Rejected("TOO_MANY_CANDIDATES");
		}
		if (noChange !== (candidates.length === 0)) return schema();
		return {
			ok: true,
			output: { noChange, candidates: candidates.map(readCandidate) },
			digest,
		};
	} catch (error) {
		if (error instanceof Rejected) {
			return { ok: false, reasonCode: error.reasonCode, digest };
		}
		// 想定外の例外（深い入れ子でのスタック枯渇など）は形の違反として扱う。
		return { ok: false, reasonCode: "OUTPUT_SCHEMA", digest };
	}
}
