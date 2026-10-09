/**
 * モデル向けの素材（固定文言 + 出力 JSON schema）。純粋で、モデルを呼ばない。モデル固有の request 形式への
 * 変換はホスト。文言と schema を変えたら `promptVersion` を上げる（ホストが `profile.promptVersion` に渡す）。
 *
 * schema は `candidate.ts` の厳密 parse と同じ形（未知のキーは run 全体が `OUTPUT_SCHEMA` で却下される）。
 * `scope` / `confidence` / `status` / `origin` はモデルに出させない（権限系の決定は Memory が行う）。
 */
import type { JsonValue } from "../../../contracts/common.ts";
import {
	MODALITIES,
	POLARITIES,
	TEMPORALS,
} from "../../../contracts/common.ts";
import type { ExtractionPromptMaterial } from "../contracts/index.ts";
import { LIMITS_EXTRACTION } from "../contracts/index.ts";
import { LIMITS_STATE, STATE_KINDS } from "../../state/contracts/index.ts";

const EVIDENCE_SCHEMA: JsonValue = {
	type: "object",
	additionalProperties: false,
	required: ["sourceIndex", "startByte", "endByte", "quote"],
	properties: {
		sourceIndex: { type: "integer", minimum: 0 },
		startByte: { type: "integer", minimum: 0 },
		endByte: { type: "integer", minimum: 1 },
		quote: { type: "string", minLength: 1 },
	},
};

const CANDIDATE_SCHEMA: JsonValue = {
	type: "object",
	additionalProperties: false,
	required: [
		"kind",
		"subject",
		"semanticKey",
		"value",
		"modality",
		"temporal",
		"evidence",
	],
	properties: {
		kind: { type: "string", enum: [...STATE_KINDS] },
		subject: { type: "string", pattern: "^(self|unknown|other:.+)$" },
		semanticKey: { type: "string", minLength: 1 },
		value: {
			type: "object",
			additionalProperties: false,
			required: ["text", "polarity"],
			properties: {
				text: { type: "string", minLength: 1 },
				polarity: { type: "string", enum: [...POLARITIES] },
			},
		},
		modality: { type: "string", enum: [...MODALITIES] },
		temporal: { type: "string", enum: [...TEMPORALS] },
		evidence: {
			type: "array",
			minItems: 1,
			maxItems: LIMITS_EXTRACTION.maxEvidencePerCandidate,
			items: EVIDENCE_SCHEMA,
		},
		replaces: { type: "string" },
	},
};

/** モデルに出させる JSON の schema。 */
export const EXTRACTION_OUTPUT_SCHEMA: JsonValue = {
	type: "object",
	additionalProperties: false,
	required: ["noChange", "candidates"],
	properties: {
		noChange: { type: "boolean" },
		candidates: {
			type: "array",
			maxItems: LIMITS_EXTRACTION.maxCandidates,
			items: CANDIDATE_SCHEMA,
		},
	},
};

/** 固定文言（日本語）。変更したら promptVersion を上げる。 */
export const EXTRACTION_INSTRUCTIONS = [
	"あなたは会話から、ユーザー本人について長く覚えておくべき事柄（好み・個人的な事実・制約・習慣）の候補だけを抜き出す。",
	"出力は JSON オブジェクト 1 つだけ。説明文・コードフェンスは付けない。形は outputSchema に従い、スキーマにないキーは出さない。",
	"",
	"規則:",
	`- 候補は最大 ${LIMITS_EXTRACTION.maxCandidates} 件。覚えるべきものがなければ {"noChange":true,"candidates":[]}。候補があれば noChange は false。`,
	"- 根拠 (evidence) は、入力 sources の本文から 1 つ以上必ず示す。sourceIndex は sources の添字、startByte / endByte は本文の UTF-8 byte 範囲（半開区間、文字の途中を指さない）、quote はその範囲の文字列と完全に一致させる。言い換えない。",
	"- 根拠にしてよいのは role が user の発言。assistant や tool の発言を根拠にした候補は後で確認に回される。",
	"- 否定は polarity を negated にする（「辛いものは好きじゃない」は text を「辛いもの」、polarity を negated）。二重否定・部分否定も本文の意味どおりに polarity を決める。",
	"- 仮定（もし〜なら）は modality を hypothetical、疑問は question、鉤括弧や引用の中の発言は quoted、伝聞（〜らしい、〜と言っていた）は reported にする。",
	"- ユーザー以外の人についての情報は subject を other:<識別子> にする。誰のことか分からなければ unknown。ユーザー本人は self。",
	"- 過去の状態は temporal を past、これからの予定は future、いまの状態は current、不明は unspecified にする。",
	"- semanticKey は同じ事柄に同じ名前を付けるための短い識別子（例: food.spicy, drink）。同じ事柄の新しい値には、同じ semanticKey を使う。",
	"- shownState に既存の項目があり、それを置き換える候補なら replaces にその itemId を書く。見せていない項目の itemId は書かない。",
	"- scope / confidence / status / origin など、採否や権限に関わる値は出力しない。",
	`- text は ${LIMITS_STATE.maxValueTextBytes} byte 以内、semanticKey は ${LIMITS_STATE.maxSemanticKeyBytes} byte 以内。`,
].join("\n");

export function buildExtractionPromptMaterial(
	promptVersion: string,
): ExtractionPromptMaterial {
	return {
		promptVersion,
		instructions: EXTRACTION_INSTRUCTIONS,
		outputSchema: EXTRACTION_OUTPUT_SCHEMA,
	};
}
