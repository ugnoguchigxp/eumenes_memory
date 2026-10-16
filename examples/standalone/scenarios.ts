import type { StateKind, StateSubject } from "eumenes-memory";
import type { Action } from "./protocol.ts";

export interface ExpectedFact {
	text: string;
	polarity: "affirmed" | "negated";
	kind: StateKind;
	subject: StateSubject;
}
export interface Step {
	task: "decide" | "recall";
	message: string;
	expected: ExpectedFact[];
	/** Semantic acceptance criterion, visible only to the post-decision judge. */
	criterion?: string;
	expectClarification?: boolean;
	expectedActions?: { remember: number; forget: number };
	/** Explicit recorded decisions for offline transport replay, never natural-language rules. */
	replay:
		| { actions: Action[]; clarification?: string | null }
		| { itemIds: string[] };
	restart?: boolean;
	restoreBeforeForget?: boolean;
}
export interface Scenario {
	id: string;
	description?: string;
	subjects?: { id: StateSubject; label: string }[];
	steps: Step[];
}

const coffee = { text: "コーヒー", polarity: "affirmed" as const };
const tea = { text: "紅茶", polarity: "affirmed" as const };
const selfPreference = (value: {
	text: string;
	polarity: "affirmed" | "negated";
}): ExpectedFact => ({ ...value, kind: "preference", subject: "self" });

export const scenarios: Scenario[] = [
	{
		id: "preference-correction-forget",
		steps: [
			{
				task: "decide",
				message: "私が好きな飲み物はコーヒーです。覚えておいてください。",
				criterion: "本人の好きな飲み物はコーヒーである。",
				expected: [selfPreference(coffee)],
				replay: {
					actions: [
						{
							type: "remember",
							kind: "preference",
							subject: "self",
							semanticKey: "favorite_drink",
							value: coffee,
							quote: "私が好きな飲み物はコーヒーです。",
							replacesItemId: null,
						},
					],
				},
			},
			{
				task: "recall",
				message: "私が好きな飲み物は何ですか？",
				criterion: "本人の好きな飲み物はコーヒーである。",
				expected: [selfPreference(coffee)],
				replay: { itemIds: ["$active:0"] },
				restart: true,
			},
			{
				task: "decide",
				message: "先ほどの好みを訂正します。今、私が好きな飲み物は紅茶です。",
				criterion:
					"本人の現在の好きな飲み物は紅茶であり、ほかの好みや職業は記憶されていない。",
				expected: [selfPreference(tea)],
				replay: {
					actions: [
						{
							type: "remember",
							kind: "preference",
							subject: "self",
							semanticKey: "favorite_drink",
							value: tea,
							quote: "今、私が好きな飲み物は紅茶です。",
							replacesItemId: "$active:0",
						},
					],
				},
			},
			{
				task: "decide",
				message:
					"もし私が宇宙飛行士だったら、オレンジジュースを好きになっていたかもしれません。これは仮定の話です。",
				criterion:
					"本人の現在の好きな飲み物は紅茶であり、ほかの好みや職業は記憶されていない。",
				expected: [selfPreference(tea)],
				replay: { actions: [] },
			},
			{
				task: "recall",
				message: "今の私の好きな飲み物を教えてください。",
				criterion:
					"本人の現在の好きな飲み物は紅茶であり、ほかの好みや職業は記憶されていない。",
				expected: [selfPreference(tea)],
				replay: { itemIds: ["$active:0"] },
			},
			{
				task: "decide",
				message:
					"私の好きな飲み物について、以前の好みも含めてすべて忘れてください。",
				expected: [],
				replay: { actions: [{ type: "forget", itemId: "$active:0" }] },
				restoreBeforeForget: true,
			},
			{
				task: "recall",
				message: "私が好きな飲み物は何ですか？",
				expected: [],
				replay: { itemIds: [] },
				restart: true,
			},
		],
	},
	{
		id: "negation",
		steps: [
			{
				task: "decide",
				message:
					"私は納豆が好きではありません。この好みを覚えておいてください。",
				criterion:
					"本人は納豆が好きではない。納豆が好き、という肯定的な好みではない。",
				expected: [selfPreference({ text: "納豆", polarity: "negated" })],
				replay: {
					actions: [
						{
							type: "remember",
							kind: "preference",
							subject: "self",
							semanticKey: "food_natto",
							value: { text: "納豆", polarity: "negated" },
							quote: "私は納豆が好きではありません。",
							replacesItemId: null,
						},
					],
				},
			},
			{
				task: "recall",
				message: "私が好きではない食べ物は何ですか？",
				criterion:
					"本人は納豆が好きではない。納豆が好き、という肯定的な好みではない。",
				expected: [selfPreference({ text: "納豆", polarity: "negated" })],
				replay: { itemIds: ["$active:0"] },
				restart: true,
			},
		],
	},
];
