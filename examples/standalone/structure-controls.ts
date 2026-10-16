import { evaluationControls } from "./regression-controls.ts";
import type { SemanticControl } from "./control-cases.ts";

/** Fixed v22 clause-reading failures and new pairing boundaries; gold frozen before v23 live calls. */
export const clauseControls: (SemanticControl & {
	criterion?: string | null;
})[] = [
	{
		name: "v22-full-clause-replay-1",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				actual: ["私の好きな飲み物は紅茶です。"],
				expected: ["紅茶"],
				polarity: "affirmed",
			},
		],
		criterion:
			"本人の現在の好きな飲み物は紅茶であり、ほかの好みや職業は記憶されていない。",
	},
	{
		name: "v22-full-clause-replay-2",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				subjectLabel: "話している本人",
				actual: ["私は星空観察に心を惹かれています。"],
				expected: ["星空観察に心を惹かれる"],
				polarity: "affirmed",
			},
		],
		criterion: "未確認の職業や出生地を保存せず、関心だけを保つ。",
	},
	{
		name: "v22-full-clause-replay-3",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "other:haru-colleague",
				kind: "other_person_note",
				subjectLabel: "同僚のハル",
				actual: ["同僚のハルは犬派です。"],
				expected: ["犬が好き"],
				polarity: "affirmed",
			},
			{
				groupId: "g1",
				subject: "other:haru-sister",
				kind: "other_person_note",
				subjectLabel: "妹のハル",
				actual: ["妹のハルは猫派です。"],
				expected: ["猫が好き"],
				polarity: "affirmed",
			},
		],
		criterion: "どちらも削除せず対象の確認を求める。",
	},
	{
		name: "v22-full-clause-replay-4",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				actual: ["好きな飲み物は紅茶です。"],
				expected: ["紅茶"],
				polarity: "affirmed",
			},
		],
		criterion:
			"本人の現在の好きな飲み物は紅茶であり、ほかの好みや職業は記憶されていない。",
	},
	{
		name: "v22-full-clause-replay-5",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "other:haru-colleague",
				kind: "other_person_note",
				subjectLabel: "同僚のハル",
				actual: ["同僚のハルは犬派である。"],
				expected: ["犬が好き"],
				polarity: "affirmed",
			},
			{
				groupId: "g1",
				subject: "other:haru-sister",
				kind: "other_person_note",
				subjectLabel: "妹のハル",
				actual: ["妹のハルは猫派である。"],
				expected: ["猫が好き"],
				polarity: "affirmed",
			},
		],
		criterion: "妹は猫好き、同僚は犬好き。",
	},
	{
		name: "v22-full-clause-replay-6",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "other:haru-sister",
				kind: "other_person_note",
				subjectLabel: "妹のハル",
				actual: ["妹のハルは猫派です。"],
				expected: ["猫が好き"],
				polarity: "affirmed",
			},
		],
		criterion: "妹の猫好きだけ。忘れた同僚の情報を補わない。",
	},
	{
		name: "v22-full-clause-replay-7",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["私は指の体操を毎晩5分続けています。"],
				expected: ["毎晩5分、指の体操をする"],
				polarity: "affirmed",
			},
			{
				groupId: "g1",
				subject: "self",
				kind: "preference",
				actual: ["私の息抜きはガラス細工です。"],
				expected: ["ガラス細工が趣味"],
				polarity: "affirmed",
			},
		],
		criterion: null,
	},
	{
		name: "unordered-multiple-facts",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["毎朝6分、笛の練習をする", "夜だけ、漢詩を2篇読む"],
				expected: ["夜だけ、漢詩を2篇読む", "毎朝6分、笛の練習をする"],
			},
		],
	},
	{
		name: "one-unmatched-predicate",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["毎朝6分、笛の音を聴く", "夜だけ、漢詩を2篇読む"],
				expected: ["夜だけ、漢詩を2篇読む", "毎朝6分、笛の練習をする"],
			},
		],
	},
	{
		name: "number-and-bound-both-material",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["毎朝、最大6分だけ笛を練習する"],
				expected: ["毎朝6分、笛を練習する"],
			},
		],
	},
];
export const structuredControls = [...evaluationControls, ...clauseControls];
