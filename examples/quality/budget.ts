/** Host-only, cross-process cost reservation. Uncertain requests keep their full reservation. */
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export interface Charge {
	id: string;
	reservedUsd: number;
	actualUsd: number | null;
	status: "reserved" | "settled" | "uncertain";
}
export interface CostLedger {
	version: 1;
	limitUsd: number;
	charges: Charge[];
	blocked?: boolean;
	uncertaintyReviews?: { ids: string[]; reason: string; at: string }[];
}
export const liability = (x: CostLedger) =>
	x.charges.reduce((s, c) => s + (c.actualUsd ?? c.reservedUsd), 0);
export class Budget {
	private initialized = false;
	constructor(
		readonly path: string,
		readonly limitUsd = 10,
	) {
		if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 10)
			throw Error("Budget must be in (0,10] USD");
		mkdirSync(dirname(path), { recursive: true });
		this.update((x) => {
			if (x.limitUsd !== limitUsd)
				throw Error("Budget cannot change during run");
		});
		this.initialized = true;
	}
	private update<T>(fn: (x: CostLedger) => T): T {
		// A stale lock fails closed. It is never silently removed or used to double-spend.
		const lock = openSync(this.path + ".lock", "wx", 0o600);
		try {
			if (this.initialized && !existsSync(this.path))
				throw Error("Active cost ledger is missing; refusing to reset budget");
			const x: CostLedger = existsSync(this.path)
				? JSON.parse(readFileSync(this.path, "utf8"))
				: { version: 1, limitUsd: this.limitUsd, charges: [] };
			if (
				!x ||
				x.version !== 1 ||
				!Array.isArray(x.charges) ||
				!Number.isFinite(x.limitUsd) ||
				x.limitUsd <= 0 ||
				x.limitUsd > 10 ||
				(x.blocked !== undefined && typeof x.blocked !== "boolean") ||
				x.charges.some(
					(c) =>
						!c ||
						typeof c.id !== "string" ||
						!c.id.trim() ||
						!["reserved", "settled", "uncertain"].includes(c.status) ||
						!Number.isFinite(c.reservedUsd) ||
						c.reservedUsd <= 0 ||
						(c.status === "settled") !== (c.actualUsd !== null) ||
						(c.actualUsd !== null &&
							(!Number.isFinite(c.actualUsd) || c.actualUsd < 0)),
				) ||
				new Set(x.charges.map((c) => c.id)).size !== x.charges.length ||
				(x.uncertaintyReviews !== undefined &&
					(!Array.isArray(x.uncertaintyReviews) ||
						x.uncertaintyReviews.some(
							(r) =>
								!r ||
								!Array.isArray(r.ids) ||
								r.ids.length === 0 ||
								new Set(r.ids).size !== r.ids.length ||
								r.ids.some(
									(id) =>
										typeof id !== "string" ||
										!x.charges.some(
											(c) => c.id === id && c.status === "uncertain",
										),
								) ||
								typeof r.reason !== "string" ||
								!r.reason.trim() ||
								typeof r.at !== "string" ||
								!Number.isFinite(Date.parse(r.at)),
						)))
			)
				throw Error("Invalid cost ledger");
			if (x.limitUsd !== this.limitUsd)
				throw Error("Budget cannot change during run");
			const result = fn(x);
			const tmp = this.path + ".tmp";
			const fd = openSync(tmp, "w", 0o600);
			try {
				writeFileSync(fd, JSON.stringify(x, null, 2) + "\n");
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, this.path);
			const directoryFd = openSync(dirname(this.path), "r");
			try {
				fsyncSync(directoryFd);
			} finally {
				closeSync(directoryFd);
			}
			return result;
		} finally {
			closeSync(lock);
			unlinkSync(this.path + ".lock");
		}
	}
	reserve(usd: number): string {
		if (!Number.isFinite(usd) || usd <= 0) throw Error("Invalid reservation");
		usd = Math.ceil(usd * 1e6) / 1e6;
		return this.update((x) => {
			if (
				x.blocked ||
				x.charges.length >= 6500 ||
				liability(x) + usd > x.limitUsd
			)
				throw Error("API_BUDGET_EXHAUSTED_OR_UNCERTAIN");
			const id = randomUUID();
			x.charges.push({
				id,
				reservedUsd: usd,
				actualUsd: null,
				status: "reserved",
			});
			return id;
		});
	}
	settle(id: string, usd: number | null): void {
		if (usd !== null && (!Number.isFinite(usd) || usd < 0))
			throw Error("Invalid charge");
		this.update((x) => {
			const c = x.charges.find((c) => c.id === id);
			if (!c || c.status !== "reserved")
				throw Error("Invalid reservation state");
			c.actualUsd = usd;
			c.status = usd === null ? "uncertain" : "settled";
			if (usd === null || usd > c.reservedUsd) x.blocked = true;
		});
	}
	snapshot(): CostLedger {
		return this.update((x) => structuredClone(x));
	}
	/** Explicit operator review only: retain every uncertain maximum; never retry or settle it here. */
	acknowledgeHeldUncertainty(ids: readonly string[], reason: string): void {
		if (!reason.trim() || ids.length === 0 || new Set(ids).size !== ids.length)
			throw Error("Invalid uncertainty review");
		this.update((x) => {
			const held = x.charges
				.filter((c) => c.status === "uncertain" && c.actualUsd === null)
				.map((c) => c.id)
				.sort();
			if (
				!x.blocked ||
				x.charges.some(
					(c) =>
						c.status === "reserved" ||
						(c.actualUsd !== null && c.actualUsd > c.reservedUsd),
				) ||
				JSON.stringify(held) !== JSON.stringify([...ids].sort()) ||
				liability(x) > x.limitUsd
			)
				throw Error(
					"Uncertainty cannot be acknowledged while active or outside reservation bounds",
				);
			x.uncertaintyReviews ??= [];
			x.uncertaintyReviews.push({
				ids: [...ids],
				reason,
				at: new Date().toISOString(),
			});
			x.blocked = false;
		});
	}
}
