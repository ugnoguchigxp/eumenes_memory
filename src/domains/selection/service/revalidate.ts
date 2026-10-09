import { compareCodeUnits } from "../../../canonical/compare.ts";
import type {
	CurrentBasis,
	RevalidationReason,
	RevalidationResult,
	UsageBasis,
} from "../contracts/index.ts";

/**
 * 回答採用時に、利用した根拠と必須集合を再検証する。
 * - 無関係な更新（利用していないitem・scopeの変更）は失効させない。
 * - 利用したitemの版変更・消失、scope認可の変更、方針の版、必須集合のdigest、関連する訂正の未処理は失効。
 * - 訂正の影響scopeが不明（`"*"`）なら保守的に失効。
 */
export function revalidateUsage(
	basis: UsageBasis,
	current: CurrentBasis,
): RevalidationResult {
	const reasons: RevalidationReason[] = [];
	if (basis.principal !== current.principal) reasons.push("PRINCIPAL_CHANGED");
	if (basis.policyRevision !== current.policyRevision)
		reasons.push("POLICY_CHANGED");
	if (basis.selectionPolicyRevision !== current.selectionPolicyRevision)
		reasons.push("SELECTION_POLICY_CHANGED");
	const currentGrants = new Map(current.grants.map((g) => [g.scopeKey, g]));
	if (
		basis.grants.some((used) => {
			const now = currentGrants.get(used.scopeKey);
			return (
				now === undefined ||
				now.revision !== used.revision ||
				now.kind !== used.kind
			);
		})
	)
		reasons.push("SCOPE_GRANT_CHANGED");
	if (
		basis.items.some(
			(used) =>
				!Object.hasOwn(current.itemRevisions, used.id) ||
				current.itemRevisions[used.id] !== used.revision,
		)
	)
		reasons.push("ITEM_CHANGED");
	if (basis.requiredDigest !== current.requiredDigest)
		reasons.push("REQUIRED_SET_CHANGED");
	if (
		current.processedSeq !== undefined &&
		current.processedSeq < basis.processedSeq
	)
		reasons.push("BOUNDARY_REGRESSED");
	if (
		current.nowMs !== undefined &&
		basis.items.some(
			(used) => used.expiresAtMs !== null && used.expiresAtMs <= current.nowMs!,
		)
	)
		reasons.push("ITEM_EXPIRED");
	const usedScopes = new Set(basis.grants.map((g) => g.scopeKey));
	if (
		current.correctedScopeKeys.some(
			(scope) => scope === "*" || usedScopes.has(scope),
		)
	)
		reasons.push("CORRECTION_PENDING");
	return reasons.length === 0
		? { status: "valid" }
		: {
				status: "invalid",
				reasons: [...new Set(reasons)].sort(compareCodeUnits),
			};
}
