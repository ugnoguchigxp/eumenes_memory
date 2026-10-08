/**
 * oracle アダプター（stub）: データセットの期待をそのまま返す。評価パイプライン自体の自己検査用で、
 * 意味精度・モデル性能の根拠にしない。入力の出典（role + content）からデータセットのケースを引く。
 */
import {
	indexBySources,
	loadDataset,
	sourcesSignature,
} from "../lib/dataset.ts";
import { goldToOutput } from "../lib/dataset.ts";
import type { EvalAdapter } from "../lib/types.ts";

const byKey = indexBySources(loadDataset());

const adapter: EvalAdapter = {
	extractorId: "eval-oracle",
	promptVersion: "oracle-1",
	providerRef: "none",
	stub: true,
	extract: (input) => {
		const evalCase = byKey.get(sourcesSignature(input.sources));
		if (evalCase === undefined) {
			return Promise.reject(new Error("oracle: input is not in the dataset"));
		}
		return Promise.resolve(goldToOutput(evalCase));
	},
};

export default adapter;
