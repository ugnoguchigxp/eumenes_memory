/**
 * アダプターモジュールの読み込み。モジュールの default export は次のどちらか:
 * - `EvalAdapter`（`extractorId` / `promptVersion` / `providerRef` / `extract`）
 * - `ExtractorPort`（関数。プロファイルはファイル名から作る）
 * 資格情報・ネットワークはアダプター側の責任（このリポジトリのコードは扱わない）。
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { LIMITS_EXTRACTION } from "eumenes-memory";
import type { ExtractorPort } from "eumenes-memory";
import type { EvalAdapter } from "./types.ts";

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function checkId(label: string, value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`adapter ${label} must be a non-empty string`);
	}
	if (encoder.encode(value).length > maxBytes) {
		throw new Error(`adapter ${label} exceeds ${maxBytes} bytes`);
	}
	return value;
}

export function toAdapter(value: unknown, fileName: string): EvalAdapter {
	if (typeof value === "function") {
		const id = basename(fileName).replace(/\.[^.]+$/u, "");
		return {
			extractorId: checkId(
				"extractorId",
				id,
				LIMITS_EXTRACTION.maxExtractorIdBytes,
			),
			promptVersion: "unknown",
			providerRef: "unknown",
			extract: value as ExtractorPort,
		};
	}
	if (!isRecord(value) || typeof value["extract"] !== "function") {
		throw new Error(
			"adapter module must default-export an EvalAdapter or an ExtractorPort",
		);
	}
	const modelId = value["modelId"];
	return {
		extractorId: checkId(
			"extractorId",
			value["extractorId"],
			LIMITS_EXTRACTION.maxExtractorIdBytes,
		),
		promptVersion: checkId(
			"promptVersion",
			value["promptVersion"],
			LIMITS_EXTRACTION.maxPromptVersionBytes,
		),
		providerRef: checkId(
			"providerRef",
			value["providerRef"],
			LIMITS_EXTRACTION.maxProviderRefBytes,
		),
		...(typeof modelId === "string" ? { modelId } : {}),
		...(value["stub"] === true ? { stub: true } : {}),
		extract: value["extract"] as ExtractorPort,
	};
}

export async function loadAdapter(absolutePath: string): Promise<EvalAdapter> {
	const module: unknown = await import(pathToFileURL(absolutePath).href);
	if (!isRecord(module)) throw new Error("adapter module did not load");
	return toAdapter(module["default"], absolutePath);
}
