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
}
export const liability = (x: CostLedger) =>
	x.charges.reduce((s, c) => s + (c.actualUsd ?? c.reservedUsd), 0);
export class Budget {
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
	}
	private update<T>(fn: (x: CostLedger) => T): T {
		// A stale lock fails closed. It is never silently removed or used to double-spend.
		const lock = openSync(this.path + ".lock", "wx", 0o600);
		try {
			const x: CostLedger = existsSync(this.path)
				? JSON.parse(readFileSync(this.path, "utf8"))
				: { version: 1, limitUsd: this.limitUsd, charges: [] };
			if (
				x.version !== 1 ||
				!Array.isArray(x.charges) ||
				!Number.isFinite(x.limitUsd) ||
				x.charges.some(
					(c) =>
						!Number.isFinite(c.reservedUsd) ||
						c.reservedUsd < 0 ||
						(c.actualUsd !== null &&
							(!Number.isFinite(c.actualUsd) || c.actualUsd < 0)),
				)
			)
				throw Error("Invalid cost ledger");
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
}
