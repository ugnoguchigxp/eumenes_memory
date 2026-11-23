/**
 * 根拠必須の検査（純粋）。長期記憶（State）・傾向の主張が、根拠（発言 ID と引用）か、候補（L1）からの昇格の記録を
 * 持たなければ拒否する。ホストは傾向（L4）など本体の外の書き込みにもこの検査を使える（`eumenes-memory` から import）。
 *
 * - 引用つきの根拠: `checkEvidence`（引用が出典の範囲と一致、出典が入力にあり現在も有効）と同じ検査。
 * - 昇格の記録: 根拠が 1 件以上、独立した会話が `minConversations`（既定 1）以上。
 * - `requireRunId`: 整理の run の ID を必須にする（Steward の書き込み用）。
 */
import { ownValue } from "../../../contracts/own.ts";
import type {
	GroundedCheckResult,
	GroundedClaim,
	GroundedPolicy,
} from "../contracts/index.ts";
import { checkEvidence } from "./evidence.ts";

export function checkGroundedClaim(
	claim: GroundedClaim,
	policy: GroundedPolicy,
	scope: { readonly principal: string; readonly scopeKey: string },
): GroundedCheckResult {
	const runId = ownValue(claim, "sourceRunId");
	if (policy.requireRunId === true && (runId === undefined || runId === "")) {
		return { ok: false, reasonCode: "RUN_ID_REQUIRED" };
	}
	const evidence = ownValue(claim, "evidence");
	if (evidence !== undefined && evidence.length > 0) {
		const sources = ownValue(claim, "sources") ?? [];
		const failure = checkEvidence({
			principal: scope.principal,
			scopeKey: scope.scopeKey,
			evidence,
			inputSources: sources,
			currentSources: sources,
		});
		return failure === null
			? { ok: true, basis: "quote" }
			: { ok: false, reasonCode: failure };
	}
	const promotion = ownValue(claim, "promotion");
	if (
		promotion === undefined ||
		promotion.candidateId === "" ||
		promotion.evidenceCount < 1
	) {
		return { ok: false, reasonCode: "NO_GROUNDING" };
	}
	const conversations = new Set(promotion.conversationIds).size;
	if (conversations < (policy.minConversations ?? 1)) {
		return { ok: false, reasonCode: "NOT_ENOUGH_CONVERSATIONS" };
	}
	return { ok: true, basis: "promotion" };
}
