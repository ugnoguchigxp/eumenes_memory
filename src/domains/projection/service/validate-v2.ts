import { deepFreeze } from "../../../canonical/freeze.ts";
import { compareCodeUnits } from "../../../canonical/compare.ts";
import {
	parseMemoryViewV2,
	parseValidationCurrentV2,
} from "../contracts/parse-v2.ts";
import type { ValidationReasonCode } from "../../../contracts/reason-codes.ts";
import type {
	MemoryViewValidationV2,
	MemoryViewV2,
	ReadyMemoryViewV2,
	ValidationCurrentV2,
} from "../../../contracts/view-v2.ts";
import { checkAccess } from "./access-check.ts";
import { composeReadyBodyV2, eligibleItemsV2 } from "./compose-v2.ts";
import type { ReadyBodyV2 } from "./compose-v2.ts";
import { checkItemsAndEvidence } from "./dependency-check.ts";
import { computeViewDigestV2 } from "./digest-v2.ts";
import { diffItemsV2 } from "./item-diff-v2.ts";

function invalid(reasonCode: ValidationReasonCode): MemoryViewValidationV2 {
	return { schemaVersion: 2, status: "invalid", reasonCode };
}

function stripDigest(view: ReadyMemoryViewV2): ReadyBodyV2 {
	const { viewDigest: _viewDigest, ...body } = view;
	return body;
}

/** view と current のヘッダー照合（V4a–V4e）。 */
function headerMismatch(
	view: ReadyMemoryViewV2,
	current: ValidationCurrentV2,
): ValidationReasonCode | null {
	if (view.principal !== current.access.principal) return "PRINCIPAL_MISMATCH";
	if (view.scopeKey !== current.snapshot.scopeKey) return "SCOPE_MISMATCH";
	if (view.purpose !== current.access.purpose) return "PURPOSE_MISMATCH";
	if (view.policyRevision !== current.access.policyRevision) {
		return "POLICY_REVISION_MISMATCH";
	}
	if (view.stateRevision !== current.snapshot.stateRevision) {
		return "STATE_REVISION_MISMATCH";
	}
	return null;
}

function validateParsed(
	view: MemoryViewV2,
	current: ValidationCurrentV2,
): MemoryViewValidationV2 {
	if (view.status !== "ready") return invalid("VIEW_NOT_READY");

	if (computeViewDigestV2(stripDigest(view)) !== view.viewDigest) {
		return invalid("VIEW_DIGEST_MISMATCH");
	}

	const accessReason = checkAccess(current.access, current.snapshot);
	if (accessReason !== null) return invalid(accessReason);

	const headerReason = headerMismatch(view, current);
	if (headerReason !== null) return invalid(headerReason);

	const itemReason = diffItemsV2(view.items, current.snapshot);
	if (itemReason !== null) return invalid(itemReason);

	// item の出典、続けて view に載っている evidence の出典。evidence の集合そのものは current に無い
	// （検索結果は呼び出し時点の候補）ので、変わっても invalid にしない。出典の状態だけを検査する。
	const sourceReason = checkItemsAndEvidence(
		[...view.items].sort((a, b) => compareCodeUnits(a.id, b.id)),
		view.evidence.map((entry) => entry.ref),
		current.snapshot,
	);
	if (sourceReason !== null) return invalid(sourceReason);

	// V8: view.dependencies・items の順序・coverage など、項目別検査が見ない部分の改ざんを、
	// current の item と view 自身の evidence / coverage からの再構築 digest との比較で検出する。
	const rebuilt = computeViewDigestV2(
		composeReadyBodyV2(
			current.access,
			current.snapshot,
			eligibleItemsV2(current.snapshot),
			view.evidence,
			view.coverage,
		),
	);
	if (rebuilt !== view.viewDigest) return invalid("VIEW_REBUILD_MISMATCH");

	return { schemaVersion: 2, status: "valid", viewDigest: rebuilt };
}

/**
 * View v2 の再検証。ホストが読み直した current に対し、view の schemaVersion 2 の形を検査する
 * （v1 の view / current は `validateMemoryView`）。構造違反は MemoryContractError。DB・ネットワークは読まない。
 */
export function validateMemoryViewV2(
	view: MemoryViewV2,
	current: ValidationCurrentV2,
): MemoryViewValidationV2 {
	const parsedView = parseMemoryViewV2(view);
	const parsedCurrent = parseValidationCurrentV2(current);
	return deepFreeze(validateParsed(parsedView, parsedCurrent));
}
