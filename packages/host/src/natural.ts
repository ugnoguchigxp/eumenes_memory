import { z } from "zod";
import type { HostItem } from "./meaning/model-input.ts";
import { demand, type HostResult, type Profile } from "./contracts.ts";
import { commandComplete, measureRecallInput } from "./model.ts";
import { request } from "./transport.ts";
import { modelItems } from "./meaning/model-input.ts";
import { parsePlan, planningSchema } from "./meaning/planning.ts";
import {
	recallSnapshot,
	UnavailableEvidenceError,
} from "./meaning/retrieval.ts";
import type { Complete } from "./meaning/protocol.ts";

const inputSchema = z
	.object({
		scopeKey: z.string().min(1).max(256),
		message: z.string().min(1),
		sourceHandle: z.string().max(256).optional(),
	})
	.strict();
/** Transport/pagination only: selection and semantic relations remain with Complete. */
async function snapshot(profile: Profile, scopeKey: string) {
	let page = await request(profile, "context", { scopeKeys: [scopeKey] });
	demand(page.status === "context", String(page.code ?? "CONTEXT_UNAVAILABLE"));
	const items = [...(page["items"] as HostItem[])];
	const id = page["snapshotId"];
	while (page["nextCursor"]) {
		page = await request(profile, "context", { cursor: page["nextCursor"] });
		demand(page.status === "context", "CONTEXT_UNAVAILABLE");
		items.push(...(page["items"] as HostItem[]));
	}
	demand(
		(page["coverage"] as { complete: boolean }).complete,
		"COMPLETE_SNAPSHOT_REQUIRED",
	);
	return { items, id };
}
export async function natural(
	profile: Profile,
	method: "plan" | "recall" | "recall-size",
	raw: unknown,
	complete: Complete = commandComplete(profile),
): Promise<HostResult> {
	const input = inputSchema.parse(raw);
	const view = await snapshot(profile, input.scopeKey);
	const items = modelItems(view.items, [], { provenance: true });
	if (method === "recall-size") {
		const measurement = measureRecallInput(items, input.message);
		const fresh = await request(profile, "read", { snapshotId: view.id });
		if (fresh.status !== "found") return fresh;
		return {
			status: "found",
			snapshotId: view.id,
			epoch: fresh["epoch"],
			measurement,
		};
	}
	if (method === "recall") {
		let answer: Awaited<ReturnType<typeof recallSnapshot>>;
		try {
			answer = await recallSnapshot(items, input.message, complete);
		} catch (error) {
			if (error instanceof UnavailableEvidenceError)
				return { status: "blocked", code: "EVIDENCE_UNAVAILABLE" };
			throw error;
		}
		const fresh = await request(profile, "read", { snapshotId: view.id });
		if (fresh.status !== "found") return fresh;
		return {
			status: "found",
			snapshotId: view.id,
			epoch: fresh["epoch"],
			...answer,
			items: items.filter((x) =>
				answer.parts.some((p) => p.evidenceIds.includes(x.itemId)),
			),
		};
	}
	let source: { content: string } | undefined;
	if (input.sourceHandle) {
		const read = await request(profile, "read", {
			sourceHandle: input.sourceHandle,
		});
		demand(read.status === "found", "SOURCE_UNAVAILABLE");
		source = read["source"] as { content: string };
	}
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["proposal", "evidence"],
		properties: {
			proposal: planningSchema(
				items.map((x) => x.itemId),
				{ quoteMode: "range" },
			),
			evidence: {
				type: "array",
				maxItems: 8,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["actionIndex", "occurrence"],
					properties: {
						actionIndex: { type: "integer", minimum: 0, maximum: 7 },
						occurrence: { type: "integer", minimum: 0 },
					},
				},
			},
		},
	};
	const response = await complete(
		JSON.stringify({
			task: "decide",
			message: input.message,
			items,
			source: source?.content ?? null,
			outputInstructions:
				"Return proposal plus evidence for executable remember actions only. Evidence occurrence is the zero-based occurrence of that exact action quote in source, counting overlapping matches. Choose the supporting occurrence explicitly. No source means no remember. Use [] evidence for same/conflicts/forget. Do not auto-apply.",
		}),
		schema,
		"decide",
	);
	const output = z
		.object({
			proposal: z.unknown(),
			evidence: z
				.array(
					z
						.object({
							actionIndex: z.number().int().min(0).max(7),
							occurrence: z.number().int().nonnegative(),
						})
						.strict(),
				)
				.max(8),
		})
		.strict()
		.parse(JSON.parse(response.raw));
	const parsed = parsePlan(JSON.stringify(output.proposal), items, "");
	const evidence = output.evidence.map((e) => {
		const action = parsed.changes.find((c) => c.actionIndex === e.actionIndex)
			?.actions[0];
		demand(
			source && action?.type === "remember" && action.quote.length,
			"EVIDENCE_INVALID",
		);
		let at = -1;
		for (let i = 0; i <= e.occurrence; i++) {
			at = source.content.indexOf(action.quote, at + 1);
			demand(at >= 0, "QUOTE_MISMATCH");
		}
		return {
			actionIndex: e.actionIndex,
			sourceHandle: input.sourceHandle,
			startByte: Buffer.byteLength(source.content.slice(0, at)),
			endByte: Buffer.byteLength(
				source.content.slice(0, at + action.quote.length),
			),
		};
	});
	return request(profile, "plan", {
		snapshotId: view.id,
		scopeKey: input.scopeKey,
		proposal: output.proposal,
		evidence,
	});
}
