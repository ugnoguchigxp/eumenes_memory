import type { AccessReasonCode } from "../contracts/reason-codes.ts";
import type { AccessContext, Snapshot } from "../contracts/types.ts";

/** build 2a–2d と validate V3 の共通判定。通れば null。 */
export function checkAccess(
	access: AccessContext,
	snapshot: Pick<
		Snapshot,
		"principal" | "scopeKey" | "policyRevision" | "complete"
	>,
): AccessReasonCode | null {
	if (access.principal !== snapshot.principal) return "PRINCIPAL_MISMATCH";
	if (!access.scopeKeys.includes(snapshot.scopeKey)) {
		return "SCOPE_NOT_PERMITTED";
	}
	if (access.policyRevision !== snapshot.policyRevision) {
		return "POLICY_REVISION_MISMATCH";
	}
	if (!snapshot.complete) return "SNAPSHOT_INCOMPLETE";
	return null;
}
