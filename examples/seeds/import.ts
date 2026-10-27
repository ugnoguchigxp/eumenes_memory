import { createHash } from "node:crypto";
import { join } from "node:path";
import { CONTRACT_VERSIONS, type HostSourceState } from "eumenes-memory";
import { assertUserState } from "eumenes-memory/sqlite";
import {
	ACCESS,
	SCOPE,
	appendDurable,
	type StandaloneHost,
} from "../standalone/host.ts";
import { parseSeedData, seedSummary, type MemorySeed } from "./data.ts";

/** Keep applicability visible to the existing model input without interpreting scope strings. */
export function seedStateText(seed: MemorySeed): string {
	return [
		seed.memory,
		`適用範囲: ${seed.scope}`,
		`利用する場面: ${seed.use_when}`,
		`条件・例外: ${seed.limitations}`,
		`状態: 本人未確認の抽出候補 (${seed.evidence_basis})。現在の依頼や指示に優先しない。`,
	].join("\n");
}

/** Initialize an example host once. No model call, semantic reclassification or overwrite. */
export function importSeedData(
	host: StandaloneHost,
	input: readonly MemorySeed[],
) {
	const seeds = parseSeedData(
		input.map((seed) => JSON.stringify(seed)).join("\n"),
	);
	const digest = createHash("sha256")
		.update(JSON.stringify(seeds))
		.digest("hex");
	const summary = seedSummary(seeds);
	const deferred = seeds
		.filter((seed) => seed.proposed_target !== "state")
		.map(({ id, proposed_target }) => ({ id, target: proposed_target }));
	return host.write((db) => {
		db.exec(
			"CREATE TABLE IF NOT EXISTS example_seed_import (id INTEGER PRIMARY KEY CHECK (id = 1), digest TEXT NOT NULL)",
		);
		const receipt = db
			.query("SELECT digest FROM example_seed_import WHERE id = 1")
			.get();
		if (receipt) {
			if (
				typeof receipt !== "object" ||
				!("digest" in receipt) ||
				receipt.digest !== digest
			)
				throw Error("Different seed dataset: use a new example directory");
			return { status: "unchanged" as const, imported: 0, summary, deferred };
		}
		if (host.list(true).length !== 0)
			throw Error("Seed initialization requires an empty example host");
		const sources: HostSourceState[] = [];
		for (const [ordinal, seed] of seeds.entries()) {
			if (seed.proposed_target !== "state") continue;
			const prefix = "本人未確認のSeed候補\n";
			const content = `${prefix}${seedStateText(seed)}\n\n元Seedと出典参照:\n${JSON.stringify(seed)}`;
			const sourceDigest = createHash("sha256").update(content).digest("hex");
			const source: HostSourceState = {
				namespace: "example-seed",
				kind: "candidate",
				id: `${digest}:${seed.id}`,
				representation: "text",
				revision: `sha256:${sourceDigest}`,
				digest: sourceDigest,
				principal: ACCESS.principal,
				scopeKey: SCOPE,
				status: "available",
				content,
				ordinal,
			};
			const result = assertUserState(db, {
				contractVersion: CONTRACT_VERSIONS.state,
				access: ACCESS,
				scopeKey: SCOPE,
				clock: { atMs: Date.now() },
				subject: seed.subject,
				kind: seed.proposed_state_kind!,
				semanticKey: seed.semantic_key,
				value: { text: seedStateText(seed), polarity: "affirmed" },
				origin: "agent_inferred",
				evidence: [
					{
						source: {
							namespace: source.namespace,
							kind: source.kind,
							id: source.id,
							representation: source.representation!,
							revision: source.revision,
							digest: source.digest,
							range: {
								startByte: Buffer.byteLength(prefix),
								endByte: Buffer.byteLength(prefix + seed.memory),
							},
						},
						quote: seed.memory,
					},
				],
				sources: [source],
			});
			if (result.status !== "applied")
				throw Error(`Seed ${seed.id}: ${JSON.stringify(result)}`);
			sources.push(source);
		}
		// Same host source archive as ordinary memory writes; fsync precedes SQLite commit.
		// The source is the extracted candidate, never a forged original conversation message.
		for (const source of sources)
			appendDurable(join(host.directory, "sources.jsonl"), source);
		db.query("INSERT INTO example_seed_import (id, digest) VALUES (1, ?)").run(
			digest,
		);
		return {
			status: "completed" as const,
			imported: sources.length,
			summary,
			deferred,
		};
	});
}
