import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withLuna } from "../../standalone/luna.ts";
import { parallel } from "../experiment.ts";
const design = JSON.parse(readFileSync(process.argv[2]!, "utf8")),
	directory = process.argv[3]!;
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const designHash = hash(design);
const schema = {
	type: "object",
	additionalProperties: false,
	required: ["verdicts"],
	properties: {
		verdicts: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "passed", "reason"],
				properties: {
					id: { type: "string" },
					passed: { type: "boolean" },
					reason: { type: "string" },
				},
			},
		},
	},
};
const clean = (facts: Record<string, unknown>[]) =>
	facts.map(({ key: _key, ...fact }) => fact);
interface Candidate {
	id: string;
	source: string;
	actual: unknown;
	expected: unknown;
}
const calibration: Candidate[] = [];
const truth: Record<string, boolean> = {};
for (let i = 0; i < 5; i++)
	for (let k = 0; k < 4; k++) {
		const id = hash([i, k]).slice(0, 16),
			n = i + 2;
		const fact = {
			subject: "self",
			kind: "personal_fact",
			polarity: "affirmed",
			text: `晴れの日だけ月${n}回散歩する`,
		};
		const actual =
			k === 0
				? { ...fact, text: `散歩は晴天の日に限り、ひと月に${n}回する` }
				: k === 1
					? { ...fact, subject: "other:friend" }
					: k === 2
						? { ...fact, text: `晴れの日だけ週${n}回散歩する` }
						: { ...fact, text: `月${n}回散歩する` };
		calibration.push({
			id,
			source: fact.text,
			actual: [actual],
			expected: [fact],
		});
		truth[id] = k === 0;
	}
const calibrationPath = join(directory, "judge-calibration.json");
await withLuna(
	async (complete) => {
		async function judge(candidates: Candidate[]) {
			const start = performance.now();
			const r = await complete(JSON.stringify({ candidates }), schema, "judge");
			const parsed = JSON.parse(r.raw);
			if (
				!Array.isArray(parsed.verdicts) ||
				parsed.verdicts.length !== candidates.length ||
				new Set(parsed.verdicts.map((x: { id: string }) => x.id)).size !==
					candidates.length ||
				parsed.verdicts.some(
					(x: { id: string; passed: unknown; reason: unknown }) =>
						!candidates.some((c) => c.id === x.id) ||
						typeof x.passed !== "boolean" ||
						typeof x.reason !== "string",
				)
			)
				throw Error("Invalid judge coverage");
			return {
				designHash,
				candidates,
				response: r,
				ms: performance.now() - start,
				verdicts: parsed.verdicts as {
					id: string;
					passed: boolean;
					reason: string;
				}[],
			};
		}
		let calibrationResult;
		if (existsSync(calibrationPath))
			calibrationResult = JSON.parse(readFileSync(calibrationPath, "utf8"));
		else {
			calibrationResult = await judge(calibration);
			writeFileSync(
				calibrationPath,
				JSON.stringify({ ...calibrationResult, truth }, null, 2) + "\n",
			);
		}
		if (calibrationResult.designHash !== designHash)
			throw Error("Calibration design mismatch");
		if (
			calibrationResult.verdicts.some(
				(x: { id: string; passed: boolean }) => truth[x.id] !== x.passed,
			)
		)
			throw Error("Calibration failed; do not grade benchmark with this judge");
		const candidates: Candidate[] = [];
		const mapping: Record<string, { file: string; arm: string }> = {};
		for (const file of readdirSync(directory)
			.filter((x) => /^[IE]\d{3}\.json$/.test(x))
			.sort()) {
			const report = JSON.parse(readFileSync(join(directory, file), "utf8"));
			if (report.designHash !== designHash || report.status !== "completed")
				throw Error("Incomplete/mixed generation report");
			for (const row of report.rows) {
				if (!row.structure) continue;
				const id = hash([report.id, row.arm, "blind"]).slice(0, 16);
				mapping[id] = { file, arm: row.arm };
				candidates.push({
					id,
					source: report.case.message,
					actual: clean(row.actual),
					expected: clean(row.expected),
				});
			}
		}
		// Ordering is deterministic and opaque; no arm, groups, key or implementation name reaches the judge.
		candidates.sort((a, b) => a.id.localeCompare(b.id));
		writeFileSync(
			join(directory, "judge-mapping.json"),
			JSON.stringify({ designHash, mapping }, null, 2) + "\n",
		);
		const jobs: (() => Promise<void>)[] = [];
		for (let i = 0; i < candidates.length; i += 8) {
			const batch = candidates.slice(i, i + 8),
				path = join(directory, `judge-${String(i / 8).padStart(3, "0")}.json`);
			jobs.push(async () => {
				if (existsSync(path)) {
					const r = JSON.parse(readFileSync(path, "utf8"));
					if (r.designHash !== designHash || hash(r.candidates) !== hash(batch))
						throw Error("Judge batch changed");
					return;
				}
				const r = await judge(batch);
				writeFileSync(path, JSON.stringify(r, null, 2) + "\n");
				console.log(
					JSON.stringify({
						batch: i / 8,
						pass: r.verdicts.filter((x) => x.passed).length,
						total: batch.length,
					}),
				);
			});
		}
		await parallel(jobs, 4);
	},
	{ judge: design.instructions.judge },
);
