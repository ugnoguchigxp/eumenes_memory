/**
 * 評価基盤（S9）の型。本体の契約（`eumenes-memory`）の語彙をそのまま使う。
 * 実モデルは呼ばない。アダプターは `ExtractorPort` を実装するモジュール（`eval/README.md`）。
 */
import type {
	ExtractorPort,
	Modality,
	Polarity,
	SourceRole,
	StateKind,
	Temporal,
} from "eumenes-memory";

/** 評価データのカテゴリ（full-system-design §6.4(b) の 12 + あいまい・絵文字記号・長文の一部）。 */
export const CATEGORIES = Object.freeze([
	"negation",
	"double_negation",
	"hypothetical",
	"question",
	"quote",
	"hearsay",
	"other_person",
	"preference_change",
	"correction",
	"past_future",
	"multi_evidence",
	"no_change",
	"ambiguous",
	"emoji_symbol",
	"long_partial",
] as const);
export type Category = (typeof CATEGORIES)[number];

export const SPLITS = Object.freeze(["dev", "test"] as const);
export type Split = (typeof SPLITS)[number];

/** gold の subject は種別だけ（`other:<識別子>` の識別子はモデルが決めるので比べない）。 */
export const SUBJECT_CLASSES = Object.freeze([
	"self",
	"other",
	"unknown",
] as const);
export type SubjectClass = (typeof SUBJECT_CLASSES)[number];

/** 比較する属性。 */
export const ATTRIBUTES = Object.freeze([
	"kind",
	"subject",
	"polarity",
	"modality",
	"temporal",
] as const);
export type Attribute = (typeof ATTRIBUTES)[number];

export interface GoldSpan {
	/** `sources` の添字。 */
	readonly source: number;
	/** 本文中にちょうど 1 回だけ現れる文字列。byte 範囲は読み込み時に求める。 */
	readonly quote: string;
}

/** 許容する追加の値（主の値に加えて）。 */
export type Acceptable = Partial<Record<Attribute, readonly string[]>>;

export interface GoldCandidate {
	readonly kind: StateKind;
	readonly subject: SubjectClass;
	readonly polarity: Polarity;
	readonly modality: Modality;
	readonly temporal: Temporal;
	/** 1 つ以上。モデルの候補の根拠がどれか 1 つと重なれば、この gold を指しているとみなす。 */
	readonly spans: readonly GoldSpan[];
	/** 人が読むための値の説明。比較しない（oracle が value.text に使う）。 */
	readonly valueHint: string;
	readonly acceptable?: Acceptable;
	/**
	 * 保存した値の意味の正解。候補の `value.text` が `anyOf` のどれかを含み、`noneOf` のどれも含まなければ正しい。
	 * 引用が合い属性が合っていても、対象・値が違う候補（別の対象の取り違えなど）を見逃さないための採点。
	 * 省略した gold は値の意味を採点しない。
	 */
	readonly valueMeaning?: {
		readonly anyOf: readonly string[];
		readonly noneOf?: readonly string[];
	};
}

export interface EvalSource {
	readonly role: SourceRole;
	readonly content: string;
}

export interface EvalCase {
	readonly id: string;
	readonly category: Category;
	readonly split: Split;
	/** gold を人が確認したか。false の間、結果は暫定（E 段階を主張しない）。 */
	readonly humanReviewed: boolean;
	readonly sources: readonly EvalSource[];
	readonly expect: {
		readonly noChange: boolean;
		readonly candidates: readonly GoldCandidate[];
	};
	/** true なら、gold があっても候補を 1 件も出さない（noChange）のも許容する（見逃しに数えない）。 */
	readonly acceptNoChange?: boolean;
	/** 候補にしてよい（過剰抽出に数えず、誤採用にも数えない）範囲。訂正前の旧値など。 */
	readonly tolerated?: readonly GoldSpan[];
	readonly note: string;
}

/** 評価が使うアダプター。default export が `EvalAdapter` か、`ExtractorPort`（関数）。 */
export interface EvalAdapter {
	readonly extractorId: string;
	readonly promptVersion: string;
	readonly providerRef: string;
	/** 実モデルの識別子（結果に記録）。stub では省略。 */
	readonly modelId?: string;
	/** true なら決定的な stub（pipeline の自己検査用）。実モデル評価（E 段階）の根拠にしない。 */
	readonly stub?: boolean;
	readonly extract: ExtractorPort;
}

/** 件数（合算できる）。 */
export const COUNT_KEYS = Object.freeze([
	"cases",
	"goldCandidates",
	"emittedCandidates",
	"candidatesWithBadEvidence",
	"matched",
	"fullMatch",
	"kindErrors",
	"subjectErrors",
	"polarityErrors",
	"modalityErrors",
	"temporalErrors",
	"valueScored",
	"valueErrors",
	"missed",
	"overExtracted",
	"duplicates",
	"tolerated",
	"acceptedNoChangeCases",
	"noChangeCases",
	"noChangeCorrect",
	"adapterFailures",
	"rejectedOutputs",
	"admitted",
	"pendingUser",
	"rejected",
	"falseAdmissions",
] as const);
export type CountKey = (typeof COUNT_KEYS)[number];
export type Counts = Readonly<Record<CountKey, number>>;

/** 比率（分母 0 は null）。 */
export const RATE_KEYS = Object.freeze([
	"candidateRecall",
	"fullMatchRate",
	"overExtractionRate",
	"quoteMismatchRate",
	"noChangeAccuracy",
	"falseAdmissionRate",
	"valueErrorRate",
] as const);
export type RateKey = (typeof RATE_KEYS)[number];

export type Metrics = Counts & Readonly<Record<RateKey, number | null>>;
export type MetricKey = CountKey | RateKey;

/** 閾値（事前に決めて結果と一緒に記録する）。`min` / `max` の片方または両方。 */
export interface Bound {
	readonly min?: number;
	readonly max?: number;
}
export type MetricBounds = Partial<Record<MetricKey, Bound>>;

export interface ThresholdsFile {
	readonly thresholdsVersion: string;
	/** "proposal" は未承認。承認前の閾値で E 段階を主張しない。 */
	readonly status: "proposal" | "approved";
	readonly decidedBy: string | null;
	readonly decidedAt: string | null;
	readonly rationale: string;
	readonly overall: MetricBounds;
	readonly categories: Partial<Record<Category, MetricBounds>>;
}
