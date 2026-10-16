import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { memoryCommand } from "../../standalone/memory.ts";
import { StandaloneHost } from "../../standalone/host.ts";
import { withLuna } from "../../standalone/luna.ts";
const output = process.argv[2];
if (!output || existsSync(output))
	throw Error("Usage: verify-entry.ts <new-result.json>");
const directory = mkdtempSync(join(tmpdir(), "memory-entry-live-"));
const turns: unknown[] = [];
const traced: typeof withLuna = async (operation, instructions) =>
	withLuna(
		(complete) =>
			operation(async (input, schema, task) => {
				const start = performance.now();
				const response = await complete(input, schema, task);
				turns.push({
					input,
					schema,
					task,
					instructions,
					response,
					ms: performance.now() - start,
				});
				return response;
			}),
		instructions,
	);
const remember = "私は休日に銀細工を楽しんでいます。覚えてください。";
const forget = "銀細工に関する私の記憶を忘れてください。";
const question = "私が休日に楽しむことは何ですか？";
const report: {
	status: string;
	directory: string;
	turns: unknown[];
	results: unknown[];
	error?: string;
} = { status: "running", directory, turns, results: [] };
const state = () => {
	const host = new StandaloneHost(directory);
	try {
		return host.list(true);
	} finally {
		host.close();
	}
};
const apply = async (message: string, id: string) => {
	const plan = await memoryCommand([directory, "plan", message], traced);
	const path = join(directory, id + ".json");
	writeFileSync(path, JSON.stringify(plan));
	const first = await memoryCommand([directory, "apply", id, path], traced);
	assert.equal("status" in first && first.status, "completed");
	const before = state();
	const again = await memoryCommand([directory, "apply", id, path], traced);
	assert.deepEqual(state(), before);
	report.results.push({ plan, first, again });
};
try {
	await apply(remember, "remember-1");
	assert.equal(state().length, 1);
	const recalled = await memoryCommand([directory, "recall", question], traced);
	assert.ok("parts" in recalled);
	assert.deepEqual(
		recalled.parts.map((p) => ({ status: p.status, ids: p.evidenceIds })),
		[{ status: "supported", ids: [state()[0]!.itemId] }],
	);
	report.results.push(recalled);
	await apply(forget, "forget-1");
	const after = await memoryCommand([directory, "recall", question], traced);
	assert.ok("parts" in after);
	assert.equal(after.coverage.itemCount, 0);
	assert.deepEqual(
		after.parts.map((p) => ({ status: p.status, ids: p.evidenceIds })),
		[{ status: "unknown", ids: [] }],
	);
	report.results.push(after);
	assert.equal(turns.length, 4);
	report.status = "passed";
} catch (error) {
	report.status = "failed";
	report.error = String(error);
	process.exitCode = 1;
} finally {
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
}
console.log(
	JSON.stringify({ status: report.status, error: report.error, directory }),
);
