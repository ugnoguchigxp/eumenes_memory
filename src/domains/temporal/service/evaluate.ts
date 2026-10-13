import type { ValidityClass, ValidityPeriod } from "../contracts/index.ts";
import { VALIDITY_BASES } from "../contracts/index.ts";
import { TemporalError, periodBoundsMs } from "./period.ts";

/** 対象時点は 1970 年より前（負の ms）でもよい。 */
function assertTarget(value: number): void {
	if (!Number.isSafeInteger(value)) throw new TemporalError("INVALID_TIME");
}

/** 期間と対象時点から 現在有効 / 過去有効 / 未来予定 / 時点不明 を決める。時計は読まない。 */
export function classifyValidity(
	period: ValidityPeriod | undefined,
	targetMs: number,
): ValidityClass {
	assertTarget(targetMs);
	if (period === undefined) return "unknown";
	if ((period as unknown) === null || typeof period !== "object")
		throw new TemporalError("INVALID_PERIOD");
	if (!(VALIDITY_BASES as readonly string[]).includes(period.basis))
		throw new TemporalError("INVALID_PERIOD");
	// 根拠が unknown でも境界の記述は検査する（不正な期間を黙って通さない）。
	const { startMs, endMs } = periodBoundsMs(period);
	if (period.basis === "unknown") return "unknown";
	if (startMs === null && endMs === null) return "unknown";
	if (startMs !== null && targetMs < startMs) return "future";
	if (endMs !== null && targetMs >= endMs) return "past";
	return "current";
}
