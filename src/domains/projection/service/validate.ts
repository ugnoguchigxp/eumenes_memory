import { deepFreeze } from "../../../canonical/freeze.ts";
import { compareCodeUnits } from "../../../canonical/compare.ts";
import { parseValidationCurrent } from "../../../contracts/parse-input.ts";
import { parseMemoryView } from "../../../contracts/parse-view.ts";
import type { ValidationReasonCode } from "../../../contracts/reason-codes.ts";
import type {
	MemoryView,
	MemoryViewValidation,
	ReadyMemoryView,
	ValidationCurrent,
} from "../../../contracts/types.ts";
import { checkAccess } from "./access-check.ts";
import { composeReadyBody, type ReadyBody } from "./compose.ts";
import { checkDependencies } from "./dependency-check.ts";
import { computeViewDigest } from "./digest.ts";
import { diffItems } from "./item-diff.ts";

function invalid(reasonCode: ValidationReasonCode): MemoryViewValidation {
	return { schemaVersion: 1, status: "invalid", reasonCode };
}

function stripDigest(view: ReadyMemoryView): ReadyBody {
	const { viewDigest: _viewDigest, ...body } = view;
	return body;
}

/** view と current のヘッダー照合（V4a–V4e）。 */
function headerMismatch(
	view: ReadyMemoryView,
	current: ValidationCurrent,
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
	view: MemoryView,
	current: ValidationCurrent,
): MemoryViewValidation {
	if (view.status !== "ready") return invalid("VIEW_NOT_READY");

	if (computeViewDigest(stripDigest(view)) !== view.viewDigest) {
		return invalid("VIEW_DIGEST_MISMATCH");
	}

	const accessReason = checkAccess(current.access, current.snapshot);
	if (accessReason !== null) return invalid(accessReason);

	const headerReason = headerMismatch(view, current);
	if (headerReason !== null) return invalid(headerReason);

	const itemReason = diffItems(view.items, current.snapshot);
	if (itemReason !== null) return invalid(itemReason);

	const sourceReason = checkDependencies(
		[...view.items].sort((a, b) => compareCodeUnits(a.id, b.id)),
		current.snapshot,
	);
	if (sourceReason !== null) return invalid(sourceReason);

	// V8: view.dependencies・items の順序・coverage など、V1–V7 の項目別検査が見ない部分の改ざんを、
	// current からの再構築 digest との比較で検出する（二重構え）。
	const rebuilt = computeViewDigest(
		composeReadyBody(current.access, current.snapshot),
	);
	if (rebuilt !== view.viewDigest) return invalid("VIEW_REBUILD_MISMATCH");

	return { schemaVersion: 1, status: "valid", viewDigest: rebuilt };
}

/**
 * ホストが読み直した current に対する view の再検証（設計書 §2.3）。
 * 構造違反は MemoryContractError。DB・ネットワークは読まない。
 */
export function validateMemoryView(
	view: MemoryView,
	current: ValidationCurrent,
): MemoryViewValidation {
	const parsedView = parseMemoryView(view);
	const parsedCurrent = parseValidationCurrent(current);
	return deepFreeze(validateParsed(parsedView, parsedCurrent));
}
