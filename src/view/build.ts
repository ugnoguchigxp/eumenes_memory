import { deepFreeze } from "../canonical/freeze.ts";
import { compareCodeUnits } from "../canonical/compare.ts";
import { parseBuildMemoryViewInput } from "../contracts/parse-input.ts";
import type {
	BlockedMemoryView,
	BuildMemoryViewInput,
	DisabledMemoryView,
	MemoryView,
	OverflowMemoryView,
} from "../contracts/types.ts";
import { checkAccess } from "./access-check.ts";
import { composeHeader, composeReadyBody } from "./compose.ts";
import { checkDependencies } from "./dependency-check.ts";
import { finalizeReadyView } from "./digest.ts";

/**
 * 判定順（設計書 §2.2）: parse → disabled → access → 依存検査 → 構成 → 予算。
 * 入力は変更せず、戻り値は新規構築の deep-frozen。
 */
export function buildMemoryView(input: BuildMemoryViewInput): MemoryView {
	const { access, snapshot, maxBytes, enabled } =
		parseBuildMemoryViewInput(input);
	const header = composeHeader(access, snapshot);

	if (!enabled) {
		const view: DisabledMemoryView = {
			...header,
			status: "disabled",
			reasonCode: "MEMORY_DISABLED",
		};
		return deepFreeze(view);
	}

	const accessReason = checkAccess(access, snapshot);
	if (accessReason !== null) {
		const view: BlockedMemoryView = {
			...header,
			status: "blocked",
			reasonCode: accessReason,
		};
		return deepFreeze(view);
	}

	const activeItems = snapshot.items
		.filter((item) => item.status === "active")
		.sort((a, b) => compareCodeUnits(a.id, b.id));
	const sourceReason = checkDependencies(activeItems, snapshot);
	if (sourceReason !== null) {
		const view: BlockedMemoryView = {
			...header,
			status: "blocked",
			reasonCode: sourceReason,
		};
		return deepFreeze(view);
	}

	const { view, byteLength } = finalizeReadyView(
		composeReadyBody(access, snapshot),
	);
	if (byteLength > maxBytes) {
		const overflow: OverflowMemoryView = {
			...header,
			status: "overflow",
			reasonCode: "BUDGET_EXCEEDED",
		};
		return deepFreeze(overflow);
	}
	return deepFreeze(view);
}
