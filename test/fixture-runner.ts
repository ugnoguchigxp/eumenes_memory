/**
 * 言語非依存 JSON fixture の実行器。src を import せず、API を引数で受け取る。
 * 期待値の検証に使う正規化・SHA-256 は、実装とは別にここで持つ。
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PublicApi {
	buildMemoryView(input: unknown): unknown;
	validateMemoryView(view: unknown, current: unknown): unknown;
}

export interface InternalApi {
	canonicalJson(value: unknown): string;
	sha256Hex(data: string | Uint8Array): string;
	utf8ByteLength(s: string): number;
	encodeUtf8(s: string): Uint8Array;
	isUtf8CharBoundary(bytes: Uint8Array, index: number): boolean;
}

type Json = unknown;

/** JSON.parse は own の "__proto__" キーを保つ（structuredClone に依存しない）。 */
function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
type Obj = Record<string, unknown>;

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);

export function loadFixtures(kind: string): Obj[] {
	const dir = join(FIXTURES_DIR, kind);
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const fixture = JSON.parse(readFileSync(join(dir, name), "utf8")) as Obj;
			expect(`${String(fixture["id"])}.json`).toBe(name);
			expect(fixture["fixtureFormat"]).toBe(1);
			expect(Array.isArray(fixture["covers"])).toBe(true);
			return fixture;
		});
}

// ---- 期待値検証用の独立実装 ----

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalize(value: Json): string {
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Obj;
		const keys = Object.keys(record).sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

// ---- RFC 6902 (add / remove / replace) と RFC 6901 の最小実装 ----

function parsePointer(pointer: string): string[] {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) throw new Error(`bad pointer ${pointer}`);
	return pointer
		.slice(1)
		.split("/")
		.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function setOwn(target: Obj, key: string, value: Json): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

export function applyPatch(document: Json, patch: readonly Obj[]): Json {
	let root: Json = jsonClone(document);
	for (const operation of patch) {
		const op = String(operation["op"]);
		const tokens = parsePointer(String(operation["path"]));
		if (tokens.length === 0) {
			if (op === "add" || op === "replace") {
				root = jsonClone(operation["value"]);
				continue;
			}
			throw new Error("cannot remove root");
		}
		let parent = root as Obj | Json[];
		for (const token of tokens.slice(0, -1)) {
			parent = (parent as Obj)[token] as Obj | Json[];
		}
		const last = tokens[tokens.length - 1] as string;
		if (Array.isArray(parent)) {
			if (op === "add") {
				const index = last === "-" ? parent.length : Number(last);
				parent.splice(index, 0, jsonClone(operation["value"]));
			} else if (op === "remove") {
				parent.splice(Number(last), 1);
			} else if (op === "replace") {
				parent[Number(last)] = jsonClone(operation["value"]);
			} else {
				throw new Error(`unsupported op ${op}`);
			}
		} else if (op === "add" || op === "replace") {
			if (op === "replace" && !Object.hasOwn(parent, last)) {
				throw new Error(`replace of missing member ${last}`);
			}
			setOwn(parent, last, jsonClone(operation["value"]));
		} else if (op === "remove") {
			delete parent[last];
		} else {
			throw new Error(`unsupported op ${op}`);
		}
	}
	return root;
}

// ---- 共通の自動検査 ----

function isDeepFrozen(value: Json): boolean {
	if (typeof value !== "object" || value === null) return true;
	if (!Object.isFrozen(value)) return false;
	return Reflect.ownKeys(value).every((key) =>
		isDeepFrozen((value as Obj)[key as string]),
	);
}

interface Outcome {
	readonly kind: "result" | "error";
	readonly value: Json;
	readonly code?: string;
	readonly path?: string;
}

function execute(run: () => unknown): Outcome {
	try {
		return { kind: "result", value: run() };
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "MemoryContractError" &&
			typeof (error as unknown as Obj)["code"] === "string"
		) {
			const detail = error as unknown as { code: string; path: string };
			return {
				kind: "error",
				value: null,
				code: detail.code,
				path: detail.path,
			};
		}
		throw error;
	}
}

function summarize(outcome: Outcome): string {
	return outcome.kind === "result"
		? `result:${JSON.stringify(outcome.value)}`
		: `error:${outcome.code}@${outcome.path}`;
}

function resolveBuildFixture(buildFixtures: Map<string, Obj>, id: string): Obj {
	const fixture = buildFixtures.get(id);
	if (!fixture) throw new Error(`unknown build fixture ${id}`);
	return fixture;
}

function resolveValidateArgs(
	fixture: Obj,
	buildFixtures: Map<string, Obj>,
): { view: Json; current: Json } {
	const resolve = (
		direct: string,
		from: string,
		pick: (build: Obj) => Json,
	): Json => {
		if (fixture[direct] !== undefined) return jsonClone(fixture[direct]);
		const ref = fixture[from] as Obj;
		const build = resolveBuildFixture(buildFixtures, String(ref["fixture"]));
		return applyPatch(pick(build), (ref["patch"] ?? []) as Obj[]);
	};
	return {
		view: resolve("view", "viewFrom", (build) => {
			const expectation = build["expect"] as Obj;
			return expectation["result"];
		}),
		current: resolve("current", "currentFrom", (build) => {
			const input = build["input"] as Obj;
			return {
				schemaVersion: input["schemaVersion"],
				access: input["access"],
				snapshot: input["snapshot"],
			};
		}),
	};
}

function checkExpectation(outcome: Outcome, expectation: Obj): void {
	if (expectation["outcome"] === "error") {
		expect(outcome.kind).toBe("error");
		expect(outcome.code).toBe(expectation["code"] as string);
		expect(outcome.path).toBe(expectation["path"] as string);
		return;
	}
	expect(outcome.kind).toBe("result");
	expect(outcome.value).toEqual(expectation["result"]);
	const result = outcome.value as Obj;
	if (result["status"] === "ready" && "canonicalWithoutDigest" in expectation) {
		const { viewDigest, ...body } = result;
		const canonical = canonicalize(body);
		expect(canonical).toBe(expectation["canonicalWithoutDigest"] as string);
		expect(sha256(canonical)).toBe(viewDigest as string);
		expect(byteLength(JSON.stringify(result))).toBe(
			expectation["finalByteLength"] as number,
		);
		expect(byteLength(canonicalize(result))).toBe(
			expectation["finalByteLength"] as number,
		);
	}
}

// ---- 登録 ----

export function describePublicFixtures(label: string, api: PublicApi): void {
	const buildFixtures = loadFixtures("build");
	const validateFixtures = loadFixtures("validate");
	const buildById = new Map(buildFixtures.map((f) => [String(f["id"]), f]));

	const runBuild = (fixture: Obj): Outcome =>
		execute(() => api.buildMemoryView(jsonClone(fixture["input"])));
	const runValidate = (fixture: Obj): Outcome => {
		const args = resolveValidateArgs(fixture, buildById);
		return execute(() => api.validateMemoryView(args.view, args.current));
	};

	describe(`${label}: build fixtures`, () => {
		for (const fixture of buildFixtures) {
			test(String(fixture["id"]), () => {
				const input = jsonClone(fixture["input"]);
				const before = JSON.stringify(input);
				const outcome = execute(() => api.buildMemoryView(input));
				expect(JSON.stringify(input)).toBe(before);
				checkExpectation(outcome, fixture["expect"] as Obj);
				if (outcome.kind === "result") {
					expect(isDeepFrozen(outcome.value)).toBe(true);
				}
				expect(summarize(runBuild(fixture))).toBe(summarize(outcome));
			});
		}
	});

	describe(`${label}: validate fixtures`, () => {
		for (const fixture of validateFixtures) {
			test(String(fixture["id"]), () => {
				const args = resolveValidateArgs(fixture, buildById);
				const beforeView = JSON.stringify(args.view);
				const beforeCurrent = JSON.stringify(args.current);
				const outcome = execute(() =>
					api.validateMemoryView(args.view, args.current),
				);
				expect(JSON.stringify(args.view)).toBe(beforeView);
				expect(JSON.stringify(args.current)).toBe(beforeCurrent);
				checkExpectation(outcome, fixture["expect"] as Obj);
				if (outcome.kind === "result") {
					expect(isDeepFrozen(outcome.value)).toBe(true);
				}
				expect(summarize(runValidate(fixture))).toBe(summarize(outcome));
			});
		}
	});

	describe(`${label}: statelessness`, () => {
		test("reordered re-run gives identical outcomes", () => {
			const first = new Map<string, string>();
			for (const fixture of buildFixtures) {
				first.set(`b:${fixture["id"]}`, summarize(runBuild(fixture)));
			}
			for (const fixture of validateFixtures) {
				first.set(`v:${fixture["id"]}`, summarize(runValidate(fixture)));
			}
			for (const fixture of [...validateFixtures].reverse()) {
				expect(summarize(runValidate(fixture))).toBe(
					first.get(`v:${fixture["id"]}`) as string,
				);
			}
			for (const fixture of [...buildFixtures].reverse()) {
				expect(summarize(runBuild(fixture))).toBe(
					first.get(`b:${fixture["id"]}`) as string,
				);
			}
		});
	});

	describe(`${label}: fixture inventory`, () => {
		test("every covers id is a known completion criterion", () => {
			const known = new Set([
				"determinism",
				"kinds-origin",
				"stale",
				"access",
				"budget",
				"utf8",
				"disabled-empty",
				"incomplete",
				"pure",
				"consumer",
				"schema",
			]);
			for (const fixture of [...buildFixtures, ...validateFixtures]) {
				for (const id of fixture["covers"] as string[]) {
					expect(known.has(id)).toBe(true);
				}
			}
		});
	});
}

// ---- View v2（schemaVersion 2）: fixtures/build-v2 と fixtures/validate-v2 ----
// 形式と検査は v1 と同じ。期待値（digest を含む）は fixture に手書きされ、digest は scripts/fixture-digest.py が
// TS の外で計算する。validate の `viewFrom` / `currentFrom` は build-v2 の fixture を参照する。

export interface PublicApiV2 {
	buildMemoryViewV2(input: unknown): unknown;
	validateMemoryViewV2(view: unknown, current: unknown): unknown;
}

const KNOWN_COVERS = new Set([
	"determinism",
	"kinds-origin",
	"stale",
	"access",
	"budget",
	"utf8",
	"disabled-empty",
	"incomplete",
	"schema",
	"subject",
	"evidence",
	"coverage",
	"v1-parity",
]);

export function describePublicFixturesV2(
	label: string,
	api: PublicApiV2,
): void {
	const buildFixtures = loadFixtures("build-v2");
	const validateFixtures = loadFixtures("validate-v2");
	const buildById = new Map(buildFixtures.map((f) => [String(f["id"]), f]));

	const runBuild = (fixture: Obj): Outcome =>
		execute(() => api.buildMemoryViewV2(jsonClone(fixture["input"])));
	const runValidate = (fixture: Obj): Outcome => {
		const args = resolveValidateArgs(fixture, buildById);
		return execute(() => api.validateMemoryViewV2(args.view, args.current));
	};

	describe(`${label}: build-v2 fixtures`, () => {
		for (const fixture of buildFixtures) {
			test(String(fixture["id"]), () => {
				const input = jsonClone(fixture["input"]);
				const before = JSON.stringify(input);
				const outcome = execute(() => api.buildMemoryViewV2(input));
				expect(JSON.stringify(input)).toBe(before);
				checkExpectation(outcome, fixture["expect"] as Obj);
				if (outcome.kind === "result") {
					expect(isDeepFrozen(outcome.value)).toBe(true);
				}
				expect(summarize(runBuild(fixture))).toBe(summarize(outcome));
			});
		}
	});

	describe(`${label}: validate-v2 fixtures`, () => {
		for (const fixture of validateFixtures) {
			test(String(fixture["id"]), () => {
				const args = resolveValidateArgs(fixture, buildById);
				const beforeView = JSON.stringify(args.view);
				const beforeCurrent = JSON.stringify(args.current);
				const outcome = execute(() =>
					api.validateMemoryViewV2(args.view, args.current),
				);
				expect(JSON.stringify(args.view)).toBe(beforeView);
				expect(JSON.stringify(args.current)).toBe(beforeCurrent);
				checkExpectation(outcome, fixture["expect"] as Obj);
				if (outcome.kind === "result") {
					expect(isDeepFrozen(outcome.value)).toBe(true);
				}
				expect(summarize(runValidate(fixture))).toBe(summarize(outcome));
			});
		}
	});

	describe(`${label}: v2 statelessness and inventory`, () => {
		test("reordered re-run gives identical outcomes", () => {
			const first = new Map<string, string>();
			for (const fixture of buildFixtures) {
				first.set(`b:${fixture["id"]}`, summarize(runBuild(fixture)));
			}
			for (const fixture of validateFixtures) {
				first.set(`v:${fixture["id"]}`, summarize(runValidate(fixture)));
			}
			for (const fixture of [...validateFixtures].reverse()) {
				expect(summarize(runValidate(fixture))).toBe(
					first.get(`v:${fixture["id"]}`) as string,
				);
			}
			for (const fixture of [...buildFixtures].reverse()) {
				expect(summarize(runBuild(fixture))).toBe(
					first.get(`b:${fixture["id"]}`) as string,
				);
			}
		});

		test("every covers id is a known criterion and both directories are populated", () => {
			expect(buildFixtures.length).toBeGreaterThan(60);
			expect(validateFixtures.length).toBeGreaterThan(30);
			for (const fixture of [...buildFixtures, ...validateFixtures]) {
				for (const id of fixture["covers"] as string[]) {
					expect(KNOWN_COVERS.has(id)).toBe(true);
				}
			}
		});

		test("every ready fixture carries an independently computed digest and byte length", () => {
			for (const fixture of buildFixtures) {
				const expectation = fixture["expect"] as Obj;
				const result = expectation["result"] as Obj | undefined;
				if (result?.["status"] === "ready") {
					expect(typeof expectation["canonicalWithoutDigest"]).toBe("string");
					expect(typeof expectation["finalByteLength"]).toBe("number");
				}
			}
		});
	});
}

export function describeInternalFixtures(api: InternalApi): void {
	describe("canonical fixtures", () => {
		for (const fixture of loadFixtures("canonical")) {
			test(String(fixture["id"]), () => {
				const canonical = api.canonicalJson(fixture["value"]);
				expect(canonical).toBe(fixture["canonical"] as string);
				expect(api.sha256Hex(canonical)).toBe(fixture["sha256"] as string);
				expect(api.utf8ByteLength(canonical)).toBe(
					fixture["utf8ByteLength"] as number,
				);
				expect(api.encodeUtf8(canonical).length).toBe(
					fixture["utf8ByteLength"] as number,
				);
			});
		}
	});

	describe("utf8 fixtures", () => {
		for (const fixture of loadFixtures("utf8")) {
			test(String(fixture["id"]), () => {
				const text = fixture["text"] as string;
				const bytes = api.encodeUtf8(text);
				expect(api.utf8ByteLength(text)).toBe(
					fixture["utf8ByteLength"] as number,
				);
				expect(bytes.length).toBe(fixture["utf8ByteLength"] as number);
				const boundaries: number[] = [];
				for (let index = 0; index <= bytes.length; index += 1) {
					if (api.isUtf8CharBoundary(bytes, index)) boundaries.push(index);
				}
				expect(boundaries).toEqual(fixture["boundaries"] as number[]);
				expect(api.isUtf8CharBoundary(bytes, bytes.length + 1)).toBe(false);
			});
		}
	});
}
