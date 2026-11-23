import { z } from "zod";
import type { HostItem } from "./meaning/model-input.ts";
import {
	demand,
	HostError,
	type HostResult,
	type Profile,
} from "./contracts.ts";
import { commandComplete, measureRecallInput } from "./model.ts";
import { request } from "./transport.ts";
import { modelItems } from "./meaning/model-input.ts";
import {
	modelAgendaItems,
	parsePlan,
	planningSchema,
	requiresQuote,
} from "./meaning/planning.ts";
import { naturalRecall, type RecallView } from "./natural-recall.ts";
import type { AgendaItem } from "./agenda-contract.ts";
import type { Complete } from "./meaning/protocol.ts";

const inputSchema = z
	.object({
		scopeKey: z.string().min(1).max(256),
		message: z.string().min(1),
		sourceHandle: z.string().max(256).optional(),
	})
	.strict();
/** Transport/pagination only: selection and semantic relations remain with Complete. */
async function snapshot(profile: Profile, scopeKey: string, agenda: boolean) {
	let page = await request(profile, "context", {
		scopeKeys: [scopeKey],
		agenda,
	});
	demand(page.status === "context", String(page.code ?? "CONTEXT_UNAVAILABLE"));
	const items = [...(page["items"] as HostItem[])];
	const agendaItems = [...((page["agendaItems"] as AgendaItem[]) ?? [])];
	const id = page["snapshotId"];
	while (page["nextCursor"]) {
		page = await request(profile, "context", {
			cursor: page["nextCursor"],
			agenda,
		});
		demand(page.status === "context", "CONTEXT_UNAVAILABLE");
		items.push(...(page["items"] as HostItem[]));
		agendaItems.push(...((page["agendaItems"] as AgendaItem[]) ?? []));
	}
	demand(
		(page["coverage"] as { complete: boolean }).complete,
		"COMPLETE_SNAPSHOT_REQUIRED",
	);
	return { items, agendaItems, id };
}
export async function natural(
	profile: Profile,
	method: "plan" | "recall" | "recall-size",
	raw: unknown,
	complete: Complete = commandComplete(profile),
): Promise<HostResult> {
	const input = inputSchema.parse(raw);
	if (method === "recall") {
		let view: RecallView | undefined;
		try {
			const full = await snapshot(profile, input.scopeKey, false);
			const items = modelItems(full.items, [], { provenance: true });
			if (measureRecallInput(items, input.message).fitsModelInput)
				view = { id: full.id, items, complete: true };
		} catch (error) {
			if (
				!(error instanceof HostError) ||
				error.code !== "COMPLETE_SNAPSHOT_REQUIRED"
			)
				throw error;
		}
		return naturalRecall(profile, input, complete, view);
	}
	const view = await snapshot(profile, input.scopeKey, method === "plan");
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
	let source: { content: string } | undefined;
	if (input.sourceHandle) {
		const read = await request(profile, "read", {
			sourceHandle: input.sourceHandle,
		});
		demand(read.status === "found", "SOURCE_UNAVAILABLE");
		demand(read["sourceRole"] !== "agent", "SOURCE_ROLE_MISMATCH");
		source = read["source"] as { content: string };
	}
	const agendaItems = modelAgendaItems(view.agendaItems);
	const schema = {
		type: "object",
		additionalProperties: false,
		required: ["proposal", "evidence"],
		properties: {
			proposal: planningSchema(
				[...items, ...agendaItems].map((x) => x.itemId),
				{ quoteMode: "range", agenda: true },
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
			agendaItems,
			message: input.message,
			items,
			source: source?.content ?? null,
			outputInstructions:
				"Return proposal plus evidence for executable remember, remember_agenda and set_agenda_status actions only. Evidence occurrence is the zero-based occurrence of that exact action quote in source, counting overlapping matches. Choose the supporting occurrence explicitly. No source means no remember. Include an evidence entry even when the executable relation is supersedes. Omit entries for same, conflicts and forget. Return an empty evidence array only if no executable action needs a quote. Do not auto-apply.",
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
	const parsed = parsePlan(
		JSON.stringify(output.proposal),
		items,
		"",
		agendaItems,
	);
	const evidence = output.evidence.map((e) => {
		const action = parsed.changes.find((c) => c.actionIndex === e.actionIndex)
			?.actions[0];
		demand(
			source && action && requiresQuote(action) && action.quote.length,
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
