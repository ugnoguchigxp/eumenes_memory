import type {
	PartialDate,
	TemporalReason,
	ValidityPeriod,
} from "../contracts/index.ts";

export class TemporalError extends Error {
	override readonly name = "TemporalError" as const;
	readonly reason: TemporalReason;
	constructor(reason: TemporalReason) {
		super(reason);
		this.reason = reason;
	}
}

const DAY_MS = 86_400_000;

/** 暦（グレゴリオ、UTC）→ 1970-01-01 からの日数。標準の civil-from-days 算法。 */
function daysFromCivil(year: number, month: number, day: number): number {
	const y = month <= 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy =
		Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { y: number; m: number; d: number } {
	const z = days + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor(
		(doe -
			Math.floor(doe / 1460) +
			Math.floor(doe / 36524) -
			Math.floor(doe / 146096)) /
			365,
	);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const m = mp < 10 ? mp + 3 : mp - 9;
	return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function utcMs(year: number, month: number, day: number): number {
	return daysFromCivil(year, month, day) * DAY_MS;
}

function isInt(value: unknown, min: number, max: number): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= min &&
		value <= max
	);
}

/** 暦として成立する日付だけを受ける（精度に無関係なフィールドは拒否）。 */
export function assertPartialDate(date: PartialDate): void {
	if (!isInt(date.year, 1, 9999)) throw new TemporalError("INVALID_DATE");
	if (date.precision === "year") {
		if (date.month !== undefined || date.day !== undefined)
			throw new TemporalError("INVALID_DATE");
		return;
	}
	if (!isInt(date.month, 1, 12)) throw new TemporalError("INVALID_DATE");
	if (date.precision === "month") {
		if (date.day !== undefined) throw new TemporalError("INVALID_DATE");
		return;
	}
	if (date.precision !== "day" || !isInt(date.day, 1, 31))
		throw new TemporalError("INVALID_DATE");
	const back = civilFromDays(daysFromCivil(date.year, date.month, date.day));
	if (back.m !== date.month || back.d !== date.day)
		throw new TemporalError("INVALID_DATE");
}

/** 精度の最初の瞬間（UTC）。 */
export function startOfMs(date: PartialDate): number {
	assertPartialDate(date);
	return utcMs(date.year, date.month ?? 1, date.day ?? 1);
}

/** 精度の次の単位の最初の瞬間（排他的な終端）。 */
export function endExclusiveMs(date: PartialDate): number {
	assertPartialDate(date);
	if (date.precision === "year") return utcMs(date.year + 1, 1, 1);
	const month = date.month as number;
	if (date.precision === "month")
		return month === 12
			? utcMs(date.year + 1, 1, 1)
			: utcMs(date.year, month + 1, 1);
	return utcMs(date.year, month, date.day as number) + DAY_MS;
}

export interface PeriodBoundsMs {
	/** 含む。`null` は始まりが不明（無限の過去）。 */
	readonly startMs: number | null;
	/** 含まない。`null` は終わりが不明（継続中）。 */
	readonly endMs: number | null;
}

export function periodBoundsMs(period: ValidityPeriod): PeriodBoundsMs {
	// 型を信用しない入力（JSON 由来など）: null や空でない非オブジェクトの日付は不正な期間。
	for (const date of [period.from, period.until] as unknown[]) {
		if (date !== undefined && (date === null || typeof date !== "object"))
			throw new TemporalError("INVALID_PERIOD");
	}
	const exact = period.fromMs !== undefined || period.untilMs !== undefined;
	if (exact && (period.from !== undefined || period.until !== undefined))
		throw new TemporalError("INVALID_PERIOD");
	if (
		(period.fromMs !== undefined && !Number.isSafeInteger(period.fromMs)) ||
		(period.untilMs !== undefined && !Number.isSafeInteger(period.untilMs))
	)
		throw new TemporalError("INVALID_TIME");
	const startMs =
		period.fromMs ??
		(period.from === undefined ? null : startOfMs(period.from));
	const endMs =
		period.untilMs ??
		(period.until === undefined ? null : endExclusiveMs(period.until));
	if (startMs !== null && endMs !== null && endMs <= startMs)
		throw new TemporalError("INVALID_PERIOD");
	return { startMs, endMs };
}

/** 既存の State が持つ `validFromMs` / `validUntilMs`（until は含まない）から、ミリ秒厳密の期間を作る。 */
export function periodFromStateMs(
	validFromMs: number | null,
	validUntilMs: number | null,
): ValidityPeriod | undefined {
	if (validFromMs === null && validUntilMs === null) return undefined;
	return {
		...(validFromMs === null ? {} : { fromMs: validFromMs }),
		...(validUntilMs === null ? {} : { untilMs: validUntilMs }),
		basis: "stated",
	};
}

const PARTIAL_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** 保存用の文字列（`2026` / `2026-09` / `2026-09-03`）。精度が文字列の長さで保たれる。 */
export function formatPartialDate(date: PartialDate): string {
	assertPartialDate(date);
	const pad = (n: number) => String(n).padStart(2, "0");
	const year = String(date.year).padStart(4, "0");
	if (date.precision === "year") return year;
	if (date.precision === "month") return `${year}-${pad(date.month as number)}`;
	return `${year}-${pad(date.month as number)}-${pad(date.day as number)}`;
}

export function parsePartialDate(text: string): PartialDate {
	const match = PARTIAL_DATE.exec(text);
	if (match === null) throw new TemporalError("INVALID_DATE");
	const year = Number(match[1]);
	const date: PartialDate =
		match[2] === undefined
			? { precision: "year", year }
			: match[3] === undefined
				? { precision: "month", year, month: Number(match[2]) }
				: {
						precision: "day",
						year,
						month: Number(match[2]),
						day: Number(match[3]),
					};
	assertPartialDate(date);
	return date;
}
