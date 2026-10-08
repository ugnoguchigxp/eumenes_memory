/**
 * 決定的な ExtractorPort のスタブ（full-system-design §4）。モデルは使わない。
 * - `cannedExtractor`: inputDigest → output の表から返す（無ければ例外）。
 * - `ruleExtractor`: 「〜が好き」「〜が嫌い」「〜は好きじゃない」の正規表現だけで候補を作る。
 *   **意味精度の主張には使わない**（パイプライン prepare → settle → forget の S 段階試験用）。
 * - `faultyExtractor`: schema 違反、範囲外 quote、11 件、巨大出力、「遅延中の副作用」（settle 前の出典の書き換え・
 *   忘却）を返す。
 */
import type { ExtractionInput, ExtractorPort } from "eumenes-memory";

const encoder = new TextEncoder();

export function cannedExtractor(
	table: Readonly<Record<string, unknown>>,
): ExtractorPort {
	return (input) => {
		if (!Object.hasOwn(table, input.inputDigest)) {
			return Promise.reject(new Error("no canned output for this input"));
		}
		return Promise.resolve(table[input.inputDigest]);
	};
}

interface Evidence {
	sourceIndex: number;
	startByte: number;
	endByte: number;
	quote: string;
}

export function evidenceFor(
	input: ExtractionInput,
	sourceIndex: number,
	quote: string,
): Evidence {
	const content = input.sources[sourceIndex]?.content ?? "";
	const at = content.indexOf(quote);
	if (at < 0) throw new Error(`quote not found: ${quote}`);
	const startByte = encoder.encode(content.slice(0, at)).length;
	return {
		sourceIndex,
		startByte,
		endByte: startByte + encoder.encode(quote).length,
		quote,
	};
}

const RULES: readonly {
	readonly pattern: RegExp;
	readonly polarity: "affirmed" | "negated";
}[] = [
	{ pattern: /^(.+?)は好きじゃない/u, polarity: "negated" },
	{ pattern: /^(.+?)が嫌い/u, polarity: "negated" },
	{ pattern: /^(.+?)が好き/u, polarity: "affirmed" },
];

/** 文（。区切り）ごとに、先頭の「私は」を除いて最初に当たる規則で 1 候補を作る。 */
export function ruleExtractor(): ExtractorPort {
	return (input) => {
		const candidates: unknown[] = [];
		for (const [index, source] of input.sources.entries()) {
			if (source.role !== "user") continue;
			for (const sentence of source.content.split("。")) {
				const body = sentence.replace(/^私は/u, "");
				for (const rule of RULES) {
					const match = rule.pattern.exec(body);
					const topic = match?.[1];
					if (match === null || topic === undefined) continue;
					if (candidates.length < 10) {
						candidates.push({
							kind: "preference",
							subject: "self",
							semanticKey: `topic.${topic}`,
							value: { text: topic, polarity: rule.polarity },
							modality: "asserted",
							temporal: "current",
							evidence: [evidenceFor(input, index, match[0])],
						});
					}
					break;
				}
			}
		}
		return Promise.resolve(
			candidates.length === 0
				? { noChange: true, candidates: [] }
				: { noChange: false, candidates },
		);
	};
}

export type Fault =
	| { readonly kind: "schema" }
	| { readonly kind: "out-of-range-quote" }
	| { readonly kind: "too-many" }
	| { readonly kind: "too-large" }
	| { readonly kind: "authority-field" }
	| {
			/** モデル実行中（settle 前）の副作用。出典の書き換え・忘却など。 */
			readonly kind: "side-effect";
			readonly run: () => void;
			readonly continueWith: ExtractorPort;
	  };

export function faultyExtractor(fault: Fault): ExtractorPort {
	return async (input, signal) => {
		const good = (sourceIndex = 0) => {
			const content = input.sources[sourceIndex]?.content ?? "";
			const quote = [...content].slice(0, 3).join("");
			return {
				kind: "preference",
				subject: "self",
				semanticKey: "topic.x",
				value: { text: "x", polarity: "affirmed" },
				modality: "asserted",
				temporal: "current",
				evidence: [evidenceFor(input, sourceIndex, quote)],
			};
		};
		switch (fault.kind) {
			case "schema":
				return { candidates: "なし" };
			case "out-of-range-quote":
				return {
					noChange: false,
					candidates: [
						{
							...good(),
							evidence: [
								{
									sourceIndex: 0,
									startByte: 99999,
									endByte: 100000,
									quote: "存在しない",
								},
							],
						},
					],
				};
			case "too-many":
				return {
					noChange: false,
					candidates: Array.from({ length: 11 }, (_, i) => ({
						...good(),
						semanticKey: `topic.${i}`,
					})),
				};
			case "too-large":
				return {
					noChange: false,
					candidates: [
						{
							...good(),
							value: { text: "あ".repeat(6000), polarity: "affirmed" },
						},
					],
				};
			case "authority-field":
				return { noChange: false, candidates: [{ ...good(), confidence: 1 }] };
			case "side-effect":
				fault.run();
				return await fault.continueWith(input, signal);
		}
	};
}
