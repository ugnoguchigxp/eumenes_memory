import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withLuna } from "../../standalone/luna.ts";
import { recallSnapshot } from "../../standalone/retrieval.ts";
import type { Complete, ModelResult } from "../../standalone/protocol.ts";
import type { RecallCase } from "./cases.ts";
import { score } from "./score.ts";
import { parallel } from "../experiment.ts";
const [designPath, directory] = process.argv.slice(2);
if (!designPath || !directory || existsSync(directory))
	throw Error("Usage: run.ts <frozen-design.json> <new-output-directory>");
const design = JSON.parse(readFileSync(designPath, "utf8"));
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const designHash = hash(design);
if (
	createHash("sha256")
		.update(
			readFileSync(new URL("../../standalone/retrieval.ts", import.meta.url)),
		)
		.digest("hex") !== design.runtimeHash
)
	throw Error("Runtime changed after freeze");
mkdirSync(directory, { recursive: true });
let providerFailures = 0,
	stopped = false;
async function evaluate(c: RecallCase, arm: string, complete: Complete) {
	let response: ModelResult | undefined,
		error: string | undefined,
		transport = false;
	let input = "",
		schema: unknown,
		result: Awaited<ReturnType<typeof recallSnapshot>> | undefined;
	const start = performance.now();
	try {
		result = await recallSnapshot(
			c.items,
			c.message,
			async (prompt, outputSchema, task) => {
				input = prompt;
				schema = outputSchema;
				try {
					response = await complete(prompt, outputSchema, task);
					providerFailures = 0;
					return response;
				} catch (e) {
					transport = true;
					providerFailures++;
					if (providerFailures >= 3) stopped = true;
					throw e;
				}
			},
		);
	} catch (e) {
		error = String(e);
	}
	return {
		arm,
		ms: performance.now() - start,
		inputHash: hash(input),
		schemaHash: hash(schema),
		response,
		error: error ?? null,
		transport,
		result,
		...score(result?.parts ?? [], c.parts),
	};
}
await withLuna(
	(before) =>
		withLuna(
			async (after) => {
				const clients: { [arm: string]: Complete } = { before, after };
				await parallel(
					([...design.holdout, ...design.regression] as RecallCase[]).map(
						(c, index) => async () => {
							if (stopped) return;
							const path = join(directory, c.id + ".json");
							const row: {
								designHash: string;
								id: string;
								family: string;
								cohort: string;
								status: string;
								rows: unknown[];
							} = {
								designHash,
								id: c.id,
								family: c.family,
								cohort: c.id.startsWith("H") ? "holdout" : "regression",
								status: "running",
								rows: [],
							};
							const save = () =>
								writeFileSync(path, JSON.stringify(row, null, 2) + "\n");
							save();
							for (const arm of index % 2
								? ["after", "before"]
								: ["before", "after"]) {
								if (stopped) break;
								row.rows.push(await evaluate(c, arm, clients[arm]!));
								save();
							}
							row.status = row.rows.length === 2 ? "completed" : "interrupted";
							save();
							console.log(
								JSON.stringify({
									id: c.id,
									rows: row.rows.map((x) => {
										const r = x as {
											arm: string;
											passed: boolean;
											transport: boolean;
										};
										return [r.arm, r.passed, r.transport];
									}),
								}),
							);
						},
					),
					design.concurrency,
				);
				if (stopped)
					throw Error("Three consecutive transport failures; dispatch stopped");
			},
			{ recall: design.instructions.after },
		),
	{ recall: design.instructions.before },
);
