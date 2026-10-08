/** 閾値ファイル（JSON）の読み込みと検査。 */
import { readFileSync } from "node:fs";
import { CATEGORIES } from "./types.ts";
import type { MetricBounds, ThresholdsFile } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBounds(label: string, value: unknown): MetricBounds {
	if (!isRecord(value))
		throw new Error(`thresholds ${label} must be an object`);
	const result: Record<string, { min?: number; max?: number }> = {};
	for (const [metric, bound] of Object.entries(value)) {
		if (!isRecord(bound))
			throw new Error(`thresholds ${label}.${metric} must be an object`);
		const entry: { min?: number; max?: number } = {};
		for (const [key, number] of Object.entries(bound)) {
			if ((key !== "min" && key !== "max") || typeof number !== "number") {
				throw new Error(`thresholds ${label}.${metric}.${key} is invalid`);
			}
			entry[key] = number;
		}
		result[metric] = entry;
	}
	return result as MetricBounds;
}

export function parseThresholds(text: string): ThresholdsFile {
	const raw: unknown = JSON.parse(text);
	if (!isRecord(raw)) throw new Error("thresholds must be an object");
	const status = raw["status"];
	if (status !== "proposal" && status !== "approved") {
		throw new Error("thresholds.status must be proposal or approved");
	}
	const decidedBy = raw["decidedBy"];
	const decidedAt = raw["decidedAt"];
	if (typeof raw["thresholdsVersion"] !== "string") {
		throw new Error("thresholds.thresholdsVersion must be a string");
	}
	if (typeof raw["rationale"] !== "string") {
		throw new Error("thresholds.rationale must be a string");
	}
	if (
		(decidedBy !== null && typeof decidedBy !== "string") ||
		(decidedAt !== null && typeof decidedAt !== "string")
	) {
		throw new Error("thresholds.decidedBy / decidedAt must be string or null");
	}
	if (status === "approved" && (decidedBy === null || decidedAt === null)) {
		throw new Error("approved thresholds need decidedBy and decidedAt");
	}
	const categoriesRaw = raw["categories"];
	if (!isRecord(categoriesRaw))
		throw new Error("thresholds.categories must be an object");
	const categories: Record<string, MetricBounds> = {};
	for (const [category, bounds] of Object.entries(categoriesRaw)) {
		if (!(CATEGORIES as readonly string[]).includes(category)) {
			throw new Error(`thresholds.categories has unknown category ${category}`);
		}
		categories[category] = readBounds(`categories.${category}`, bounds);
	}
	return {
		thresholdsVersion: raw["thresholdsVersion"],
		status,
		decidedBy,
		decidedAt,
		rationale: raw["rationale"],
		overall: readBounds("overall", raw["overall"]),
		categories,
	};
}

export function loadThresholds(path: string): {
	readonly thresholds: ThresholdsFile;
	readonly text: string;
} {
	const text = readFileSync(path, "utf8");
	return { thresholds: parseThresholds(text), text };
}
