import { describe, expect, test } from "bun:test";
import {
	TemporalError,
	answersQuery,
	classifyValidity,
	endExclusiveMs,
	evaluateTime,
	formatPartialDate,
	parsePartialDate,
	periodBoundsMs,
	periodFromStateMs,
	startOfMs,
} from "../index.ts";
import type { PartialDate, ValidityPeriod } from "../index.ts";

const utc = (iso: string): number => {
	const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
	return epochDays(y, m, d) * 86_400_000;
};
function epochDays(y: number, m: number, d: number): number {
	// 独立した算法（月ごとの日数の累積）で期待値を作る。
	const leap = (n: number) => (n % 4 === 0 && n % 100 !== 0) || n % 400 === 0;
	let days = 0;
	for (let year = 1970; year < y; year++) days += leap(year) ? 366 : 365;
	const lengths = [
		31,
		leap(y) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	for (let month = 1; month < m; month++) days += lengths[month - 1] as number;
	return days + d - 1;
}

const SEPT: PartialDate = { precision: "month", year: 2026, month: 9 };

describe("partial dates", () => {
	test("month precision does not invent a day: from covers the whole month", () => {
		expect(startOfMs(SEPT)).toBe(utc("2026-09-01"));
		expect(endExclusiveMs(SEPT)).toBe(utc("2026-10-01"));
		expect(endExclusiveMs({ precision: "month", year: 2026, month: 12 })).toBe(
			utc("2027-01-01"),
		);
		expect(endExclusiveMs({ precision: "year", year: 2026 })).toBe(
			utc("2027-01-01"),
		);
		expect(
			endExclusiveMs({ precision: "day", year: 2024, month: 2, day: 29 }),
		).toBe(utc("2024-03-01"));
	});

	test("rejects impossible or inconsistent dates", () => {
		const bad: PartialDate[] = [
			{ precision: "day", year: 2026, month: 2, day: 30 },
			{ precision: "day", year: 2026, month: 13, day: 1 },
			{ precision: "month", year: 2026, month: 9, day: 1 },
			{ precision: "year", year: 2026, month: 1 },
			{ precision: "month", year: 2026 },
			{ precision: "day", year: 2025, month: 2, day: 29 },
		];
		for (const date of bad) {
			expect(() => startOfMs(date)).toThrow(TemporalError);
		}
	});

	test("rejects reversed and mixed periods", () => {
		expect(() =>
			periodBoundsMs({
				from: SEPT,
				until: { precision: "month", year: 2026, month: 8 },
				basis: "stated",
			}),
		).toThrow(TemporalError);
		expect(() =>
			periodBoundsMs({ from: SEPT, fromMs: 1, basis: "stated" }),
		).toThrow(TemporalError);
	});
});

describe("early dates", () => {
	test("years before 1970 are supported", () => {
		const p: ValidityPeriod = {
			from: { precision: "year", year: 1960 },
			until: { precision: "year", year: 1969 },
			basis: "stated",
		};
		expect(classifyValidity(p, 0)).toBe("past");
		expect(periodBoundsMs(p).startMs).toBeLessThan(0);
	});
});

describe("pre-1970 queries and malformed input", () => {
	test("a question about 1965 can be asked and answered", () => {
		const p: ValidityPeriod = {
			from: { precision: "year", year: 1960 },
			until: { precision: "year", year: 1969 },
			basis: "stated",
		};
		const ms = (year: number) => startOfMs({ precision: "year", year });
		expect(classifyValidity(p, ms(1965))).toBe("current");
		expect(classifyValidity(p, ms(1959))).toBe("future");
		expect(classifyValidity(p, ms(1970))).toBe("past");
		expect(
			answersQuery(
				{ recordedAtMs: 0, period: p },
				{ mode: "at", atMs: 10, targetMs: ms(1965), basis: "valid_then" },
			),
		).toBe(true);
	});
	test("null dates and unknown bases are rejected, not coerced", () => {
		expect(() =>
			classifyValidity({ from: null as never, basis: "stated" }, 0),
		).toThrow(TemporalError);
		expect(() =>
			classifyValidity({ fromMs: 0, basis: "bogus" as never }, 5),
		).toThrow(TemporalError);
	});
	test("dates round-trip through their stored text, including years below 1000", () => {
		for (const date of [
			{ precision: "year", year: 500 },
			{ precision: "month", year: 999, month: 3 },
			{ precision: "day", year: 1, month: 1, day: 1 },
			{ precision: "day", year: 2026, month: 9, day: 3 },
		] as const) {
			expect(parsePartialDate(formatPartialDate(date))).toEqual(date);
		}
	});
});

describe("classification", () => {
	const since: ValidityPeriod = { from: SEPT, basis: "stated" };
	test("'since September' heard in October is current now, future before, never a confirmed 1 Sep", () => {
		expect(classifyValidity(since, utc("2026-10-09"))).toBe("current");
		expect(classifyValidity(since, utc("2026-09-01"))).toBe("current");
		expect(classifyValidity(since, utc("2026-08-31"))).toBe("future");
	});
	test("closed periods: past after the end, end is the last instant of its unit", () => {
		const p: ValidityPeriod = {
			from: { precision: "year", year: 2020 },
			until: { precision: "month", year: 2026, month: 8 },
			basis: "stated",
		};
		expect(classifyValidity(p, utc("2026-08-31") + 86_399_999)).toBe("current");
		expect(classifyValidity(p, utc("2026-09-01"))).toBe("past");
		expect(classifyValidity(p, utc("2019-12-31"))).toBe("future");
	});
	test("no period or unknown basis is unknown", () => {
		expect(classifyValidity(undefined, 5)).toBe("unknown");
		expect(classifyValidity({ basis: "unknown" }, 5)).toBe("unknown");
		expect(
			classifyValidity({ from: SEPT, basis: "unknown" }, utc("2026-10-01")),
		).toBe("unknown");
	});
	test("exact State bounds: until is exclusive", () => {
		const p = periodFromStateMs(100, 200);
		expect(classifyValidity(p, 99)).toBe("future");
		expect(classifyValidity(p, 100)).toBe("current");
		expect(classifyValidity(p, 199)).toBe("current");
		expect(classifyValidity(p, 200)).toBe("past");
		expect(periodFromStateMs(null, null)).toBeUndefined();
	});
	test("rejects negative or fractional host time", () => {
		expect(() => classifyValidity(since, Number.NaN)).toThrow(TemporalError);
		expect(() => classifyValidity(since, 1.5)).toThrow(TemporalError);
	});
});

describe("queries: now vs past vs 'this time'", () => {
	const old = {
		recordedAtMs: utc("2024-01-01"),
		period: {
			until: { precision: "month", year: 2026, month: 8 },
			basis: "stated",
		},
	} as const;
	const next = {
		recordedAtMs: utc("2026-10-01"),
		period: { from: SEPT, basis: "stated" },
	} as const;
	const undated = { recordedAtMs: utc("2025-01-01") } as const;
	const now = { mode: "current", atMs: utc("2026-10-09") } as const;
	const then = {
		mode: "at",
		atMs: utc("2026-10-09"),
		targetMs: utc("2026-03-01"),
	} as const;

	test("current question uses B (since Sep), not A (until Aug)", () => {
		expect(answersQuery(old, now)).toBe(false);
		expect(answersQuery(next, now)).toBe(true);
	});
	test("past question returns to A, and B (recorded later) is not known then", () => {
		expect(answersQuery(old, then)).toBe(true);
		expect(answersQuery(next, then)).toBe(false);
		expect(evaluateTime(next, then).recordedAfterTarget).toBe(true);
	});
	test("valid_then returns facts learned later that held at the target time", () => {
		const q = { ...then, basis: "valid_then" } as const;
		const sepTarget = {
			mode: "at",
			atMs: utc("2026-10-09"),
			targetMs: utc("2026-09-15"),
			basis: "valid_then",
		} as const;
		expect(answersQuery(next, sepTarget)).toBe(true);
		expect(answersQuery(next, { ...sepTarget, basis: "known_then" })).toBe(
			false,
		);
		expect(answersQuery(old, q)).toBe(true);
	});
	test("undated entries answer current questions by default only", () => {
		expect(answersQuery(undated, now)).toBe(true);
		expect(answersQuery(undated, now, { includeUnknownInCurrent: false })).toBe(
			false,
		);
		expect(answersQuery(undated, then)).toBe(false);
	});
	test("coarse is flagged for month precision", () => {
		expect(evaluateTime(next, now).coarse).toBe(true);
		expect(evaluateTime(undated, now).coarse).toBe(false);
	});
});
