import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLuna, MODEL, SDK_VERSION } from "../standalone/luna.ts";
import type { Complete, ModelTask, ModelResult } from "./frozen-protocol.ts";
import frozen from "./prompts.json";

export const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type Instructions = Record<ModelTask, string>;
export const variants = frozen;
export interface Observation {
	id: string;
	task: ModelTask;
	variant: string;
	input: unknown;
	schema: unknown;
	instructions: string;
	inputHash: string;
	durationMs: number;
	response?: ModelResult;
	error?: string;
}
export class Experiment {
	readonly observations: Observation[] = [];
	readonly results: Record<string, unknown>[] = [];
	private readonly started = Date.now();
	constructor(
		readonly directory: string,
		readonly phase: string,
		readonly design: unknown,
	) {
		if (existsSync(join(directory, "report.json")))
			throw Error("Experiment output already exists; choose a new directory");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.save("running");
	}
	save(status: "running" | "completed" | "failed", error?: string): void {
		writeFileSync(
			join(this.directory, "report.json"),
			JSON.stringify(
				{
					phase: this.phase,
					status,
					model: MODEL,
					sdkVersion: SDK_VERSION,
					design: this.design,
					designHash: hash(this.design),
					durationMs: Date.now() - this.started,
					observations: this.observations,
					results: this.results,
					...(error ? { error } : {}),
				},
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
	}
	async call(
		complete: Complete,
		variant: string,
		instructions: Instructions,
		id: string,
		input: unknown,
		schema: unknown,
		task: ModelTask,
	): Promise<string> {
		const row: Observation = {
			id,
			variant,
			task,
			input,
			schema,
			instructions: instructions[task],
			inputHash: hash({ input, schema, instruction: instructions[task] }),
			durationMs: 0,
		};
		this.observations.push(row);
		this.save("running");
		const start = performance.now();
		try {
			row.response = await complete(JSON.stringify(input), schema, task);
			return row.response.raw;
		} catch (error) {
			row.error = String(error);
			throw error;
		} finally {
			row.durationMs = Math.round(performance.now() - start);
			this.save("running");
		}
	}
	result(value: Record<string, unknown>): void {
		this.results.push(value);
		this.save("running");
		console.log(JSON.stringify(value));
	}
}
/** Drain running calls before removing the isolated SDK home. Stop dispatch on provider failure. */
export async function parallel(
	jobs: (() => Promise<void>)[],
	concurrency = 3,
): Promise<void> {
	let next = 0;
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
			while (failure === undefined && next < jobs.length) {
				const job = jobs[next++]!;
				try {
					await job();
				} catch (error) {
					failure = error;
				}
			}
		}),
	);
	if (failure !== undefined) throw failure;
}
export async function withVariants<T>(
	operation: (clients: Record<"v9" | "v10", Complete>) => Promise<T>,
): Promise<T> {
	return withLuna(
		(v9) =>
			withLuna((v10) => operation({ v9, v10 }), variants.v10.instructions),
		variants.v9.instructions,
	);
}
