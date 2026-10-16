import { structuredControls } from "./structure-controls.ts";
import type { SemanticControl } from "./control-cases.ts";

/** Context can resolve an omitted relation, never a missing restriction or a second denial. */
export const contextControls: (SemanticControl & { criterion?: string })[] = [
	{
		name: "context-resolves-bare-preference-relation",
		expectedPassed: true,
		criterion: "本人が好む書体は明朝体である。",
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				polarity: "affirmed",
				actual: ["私が好む書体は明朝体です。"],
				expected: ["明朝体"],
			},
		],
	},
	{
		name: "context-cannot-add-reverse-exclusive-bound",
		expectedPassed: false,
		criterion: "朝にだけ散歩する習慣を持つ。",
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["朝にだけ散歩する"],
				expected: ["朝に散歩する"],
			},
		],
	},
	{
		name: "context-denial-is-not-applied-twice",
		expectedPassed: true,
		criterion: "本人は胡椒の香りを好まない。",
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				polarity: "negated",
				actual: ["胡椒の香りが好きである"],
				expected: ["胡椒の香り"],
			},
		],
	},
];

export const allControls = [...structuredControls, ...contextControls];
