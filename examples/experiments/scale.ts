import { listState } from "eumenes-memory/sqlite";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneHost, ACCESS, SCOPE } from "../standalone/host.ts";
import { modelItems } from "../standalone/model-input.ts";
import { parseRecall } from "./frozen-protocol.ts";
import { withLuna } from "../standalone/luna.ts";
import { allState, scanRecall, retrievalInstructions } from "./retrieval.ts";
import { Experiment, parallel, variants } from "./experiment.ts";
import { sameIds } from "./factorial.ts";
import {
	buildDirectory,
	directoryRecall,
	directoryInstructions,
} from "./directory.ts";
import type { Complete } from "./frozen-protocol.ts";

const probes = [
	{
		position: "oldest",
		text: "月曜日の朝は運河沿いを歩く",
		message: "月曜日の朝の散歩場所は？",
		kind: "habit" as const,
	},
	{
		position: "middle",
		text: "今の勤務先は北風工房",
		message: "今の勤め先を教えて。",
		kind: "personal_fact" as const,
	},
	{
		position: "newest",
		text: "冬の旅行では雪道の運転を避ける",
		message: "冬の旅行で避けたい移動は？",
		kind: "constraint" as const,
	},
];
export async function scale(directory: string, live: boolean) {
	const exp = new Experiment(directory, live ? "scale-live" : "scale-storage", {
		sizes: live ? [100, 1001] : [999, 1000, 1001, 10000],
		probes,
		methods: ["latest-1000", "all", "page-scan", "directory"],
		pageSize: 250,
		instructions: retrievalInstructions,
		directoryInstructions,
		policy:
			"Real SQLite, same ordered authorized corpus and queries across methods. One call sample per size/query/method; descriptive stress comparison, not accuracy estimate. Local storage probes include deletion, stale DB restore and survivors. No embedding/lexical heuristics.",
	});
	try {
		const operation = async (
			complete?: Complete,
			build?: Complete,
			route?: Complete,
		) => {
			for (const size of live ? [100, 1001] : [999, 1000, 1001, 10000]) {
				const dir = mkdtempSync(join(tmpdir(), "memory-scale-"));
				let host = new StandaloneHost(dir);
				try {
					const ids: string[] = [];
					const start = performance.now();
					for (let i = 0; i < size; i++) {
						const target =
							i === 0
								? 0
								: i === Math.floor(size / 2)
									? 1
									: i === size - 1
										? 2
										: -1;
						const text =
							target < 0
								? `展示品番号${i}の色合いが好き`
								: probes[target]!.text;
						const saved = host.remember(
							{
								type: "remember",
								subject: "self",
								kind: target < 0 ? "preference" : probes[target]!.kind,
								semanticKey: `fact-${i}`,
								value: { text, polarity: "affirmed" },
								quote: text,
								replacesItemId: null,
							},
							text,
						);
						if (target >= 0) ids[target] = saved.itemId;
					}
					const seedMs = Math.round(performance.now() - start);
					const began = performance.now();
					const all = host.read((db) => allState(db, ACCESS, SCOPE));
					const readMs = Math.round(performance.now() - began);
					// Preserve the pre-pagination behavior explicitly as the control arm.
					const firstPage = host.read((db) =>
						listState(db, {
							contractVersion: 1,
							access: ACCESS,
							scopeKey: SCOPE,
						}),
					);
					if (firstPage.status !== "ok") throw Error(firstPage.status);
					if (
						all.length !== size ||
						new Set(all.map((i) => i.itemId)).size !== size
					)
						throw Error("Incomplete enumeration");
					exp.result({
						type: "storage",
						size,
						seedMs,
						readMs,
						enumerated: all.length,
						latestCount: firstPage.items.length,
					});
					if (complete) {
						const full = modelItems(all);
						const latest = modelItems(firstPage.items);
						if (!build || !route) throw Error("Directory clients required");
						const buildStart = performance.now();
						const directory = await buildDirectory(
							exp,
							build,
							`${size}/build`,
							full,
						);
						exp.result({
							type: "directory-build",
							size,
							pages: directory.length,
							elapsedMs: Math.round(performance.now() - buildStart),
						});
						const jobs: (() => Promise<void>)[] = [];
						for (const [index, p] of probes.entries())
							for (const method of [
								"latest-1000",
								"all",
								"page-scan",
								"directory",
							] as const)
								jobs.push(async () => {
									const before = performance.now();
									const id = `${size}/${p.position}/${method}`;
									let selected: string[];
									let candidates: string[] | undefined;
									if (method === "directory") {
										({ selected, candidates } = await directoryRecall(
											exp,
											route,
											complete,
											id,
											p.message,
											directory,
										));
									} else if (method === "page-scan")
										selected = await scanRecall(
											exp,
											complete,
											id,
											p.message,
											full,
										);
									else {
										const items = method === "all" ? full : latest;
										const raw = await exp.call(
											complete,
											method,
											retrievalInstructions,
											id,
											{ task: "recall", message: p.message, items },
											variants.v10.recallSchema,
											"recall",
										);
										selected = parseRecall(raw);
										if (
											selected.some((x) => !items.some((y) => y.itemId === x))
										)
											throw Error("Unknown recall ID");
									}
									exp.result({
										type: "recall",
										size,
										position: p.position,
										method,
										passed: sameIds(selected, [ids[index]!]),
										elapsedMs: Math.round(performance.now() - before),
										selected,
										...(candidates
											? {
													candidateCount: candidates.length,
													candidateHit: candidates.includes(ids[index]!),
												}
											: {}),
									});
								});
						await parallel(jobs);
					}
					const backup = join(dir, "before-forget.db");
					host.snapshot(backup);
					host.forgetFact(ids[0]!);
					const survivors = host
						.read((db) => allState(db, ACCESS, SCOPE))
						.map((x) => x.itemId);
					if (survivors.length !== size - 1 || survivors.includes(ids[0]!))
						throw Error("Forget failed");
					host.close();
					rmSync(join(dir, "memory.db-wal"), { force: true });
					rmSync(join(dir, "memory.db-shm"), { force: true });
					copyFileSync(backup, join(dir, "memory.db"));
					host = new StandaloneHost(dir);
					const restored = host
						.read((db) => allState(db, ACCESS, SCOPE))
						.map((x) => x.itemId);
					if (!sameIds(restored, survivors))
						throw Error("Restore resurrected/removed data");
					exp.result({
						type: "recovery",
						size,
						survivors: restored.length,
						forgottenAbsent: !restored.includes(ids[0]!),
						passed: true,
					});
				} finally {
					host.close();
					rmSync(dir, { recursive: true, force: true });
				}
			}
		};
		if (live)
			await withLuna(
				(complete) =>
					withLuna(
						(build) =>
							withLuna(
								(route) => operation(complete, build, route),
								directoryInstructions.route,
							),
						directoryInstructions.build,
					),
				retrievalInstructions,
			);
		else await operation();
		exp.save("completed");
	} catch (error) {
		exp.save("failed", String(error));
		throw error;
	}
}
if (import.meta.main) {
	if (
		!["--live", "--offline"].includes(process.argv[2] ?? "") ||
		!process.argv[3]
	)
		throw Error(
			"Usage: bun examples/experiments/scale.ts --live|--offline <output-directory>",
		);
	await scale(process.argv[3], process.argv[2] === "--live");
}
