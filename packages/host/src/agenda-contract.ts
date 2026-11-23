import { z } from "zod";
import type { SourceRef } from "eumenes-memory";

export const userAgendaKinds = [
	"plan",
	"concern",
	"conditional_request",
	"temporary_instruction",
] as const;
export const terminalAgendaStatus = z.enum(["done", "cancelled"]);
const boundedText = z.string().min(1).max(1024).regex(/\S/);
const instant = z.iso.datetime({ offset: true });
const date = z.union([
	z.iso.date(),
	z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
	instant,
]);
export const agendaDetails = z.strictObject({
	text: boundedText,
	certainty: z.enum(["confirmed", "tentative"]),
	time: z
		.strictObject({
			original: boundedText,
			scheduledFor: date.nullable(),
			deadline: date.nullable(),
			validUntil: date.nullable(),
		})
		.nullable(),
	trigger: z
		.union([
			z.strictObject({ type: z.literal("time"), at: date }),
			z.strictObject({ type: z.literal("event"), condition: boundedText }),
		])
		.nullable(),
});
const id = z.string().min(1).max(256);
export const rememberAgenda = z.strictObject({
	type: z.literal("remember_agenda"),
	kind: z.enum(userAgendaKinds),
	...agendaDetails.shape,
	quote: boundedText,
	replacesItemId: id.nullable(),
});
export const setAgendaStatus = z.strictObject({
	type: z.literal("set_agenda_status"),
	itemId: id,
	status: terminalAgendaStatus,
	quote: boundedText,
});
export const agendaAction = z.discriminatedUnion("type", [
	rememberAgenda,
	setAgendaStatus,
]);
export type AgendaAction = z.infer<typeof agendaAction>;
export type AgendaDetails = z.infer<typeof agendaDetails>;
export type AgendaStatus = "pending" | z.infer<typeof terminalAgendaStatus>;
export type AgendaKind = (typeof userAgendaKinds)[number] | "commitment";
export interface AgendaItem extends AgendaDetails {
	itemId: string;
	scopeKey: string;
	kind: AgendaKind;
	sourceRole: "user" | "agent";
	status: AgendaStatus;
	updatedAtMs: number;
	evidence: SourceRef;
	quote: string;
}

export const directAgendaWrite = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("record_commitment"),
		scopeKey: id,
		sourceHandle: id,
		startByte: z.number().int().nonnegative(),
		endByte: z.number().int().positive(),
		quote: boundedText,
		...agendaDetails.omit({ certainty: true }).shape,
	}),
	z.strictObject({
		type: z.literal("set_agenda_status"),
		scopeKey: id,
		itemId: id,
		status: terminalAgendaStatus,
	}),
]);
