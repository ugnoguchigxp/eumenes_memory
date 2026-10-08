/**
 * echo-noop アダプター（stub）: 常に noChange を返す。noChange 精度が満点・再現率が 0 になる下限の基準。
 */
import type { EvalAdapter } from "../lib/types.ts";

const adapter: EvalAdapter = {
	extractorId: "eval-echo-noop",
	promptVersion: "noop-1",
	providerRef: "none",
	stub: true,
	extract: () => Promise.resolve({ noChange: true, candidates: [] }),
};

export default adapter;
