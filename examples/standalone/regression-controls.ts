import { semanticControls } from "./control-cases.ts";
import type { SemanticControl } from "./control-cases.ts";

/** Fixed v21 failures plus opposing boundaries, declared before v22 live measurement.
 * Paired criteria test input availability; neither verdict nor raw source history is sent. */
export const regressionControls: (SemanticControl & {
	criterion?: string | null;
})[] = [
	{
		name: "v21-source-faithful-1",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["発声練習を平日だけ週4回、1回20分ずつ続けている。"],
				expected: ["平日だけ、週4回、1回20分ずつ発声練習をする"],
				polarity: "affirmed",
			},
		],
	},
	{
		name: "v21-source-faithful-1-with-criterion",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["発声練習を平日だけ週4回、1回20分ずつ続けている。"],
				expected: ["平日だけ、週4回、1回20分ずつ発声練習をする"],
				polarity: "affirmed",
			},
		],
		criterion: "平日だけ、週4回、1回20分を落とさない。",
	},
	{
		name: "v21-source-faithful-2",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "other:ito",
				kind: "other_person_note",
				subjectLabel: "同僚のイト",
				actual: ["イトの気晴らしは写真です。"],
				expected: ["写真が趣味"],
				polarity: "affirmed",
			},
		],
	},
	{
		name: "v21-source-faithful-3",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["私は毎朝10分間ストレッチをしている。"],
				expected: ["毎朝10分間ストレッチをする"],
				polarity: "affirmed",
			},
			{
				groupId: "g1",
				subject: "self",
				kind: "preference",
				actual: ["私の趣味は陶芸である。"],
				expected: ["陶芸が趣味"],
				polarity: "affirmed",
			},
		],
	},
	{
		name: "v21-source-faithful-3-with-criterion",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["私は毎朝10分間ストレッチをしている。"],
				expected: ["毎朝10分間ストレッチをする"],
				polarity: "affirmed",
			},
			{
				groupId: "g1",
				subject: "self",
				kind: "preference",
				actual: ["私の趣味は陶芸である。"],
				expected: ["陶芸が趣味"],
				polarity: "affirmed",
			},
		],
		criterion:
			"陶芸は好み、毎朝10分のストレッチは習慣。陶芸の実施頻度は未提供。",
	},
	{
		name: "v21-source-faithful-4",
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
	},
	{
		name: "v21-source-faithful-4-with-criterion",
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
		name: "v21-source-faithful-5",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["発声練習を平日だけ、週4回、1回20分ずつ続けている。"],
				expected: ["平日だけ、週4回、1回20分ずつ発声練習をする"],
				polarity: "affirmed",
			},
		],
	},
	{
		name: "v21-source-faithful-5-with-criterion",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["発声練習を平日だけ、週4回、1回20分ずつ続けている。"],
				expected: ["平日だけ、週4回、1回20分ずつ発声練習をする"],
				polarity: "affirmed",
			},
		],
		criterion: "平日限定、週4回、1回20分という三条件すべてを持つ習慣。",
	},
	{
		name: "v21-source-faithful-6",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				actual: ["指の体操を毎晩5分続けています。"],
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
	},
	{
		name: "explicit-start-date-must-match",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["2022年から毎晩15分、素振りを続けている"],
				expected: ["毎晩15分、素振りをする"],
			},
		],
	},
	{
		name: "completed-routine-is-not-current",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["以前は毎晩15分、素振りをしていたが、今はやめた"],
				expected: ["毎晩15分、素振りをする"],
			},
		],
	},
	{
		name: "explicit-purpose-is-material",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				polarity: "affirmed",
				actual: ["緊張を抑えるために折り紙をする"],
				expected: ["折り紙が趣味"],
			},
		],
	},
	{
		name: "explicit-preference-comparison-is-material",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				polarity: "affirmed",
				actual: ["犬より猫が好き"],
				expected: ["猫が好き"],
			},
		],
	},
	{
		name: "criterion-cannot-fill-missing-limit",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["毎晩15分、素振りをする"],
				expected: ["雨の日だけ、毎晩15分、素振りをする"],
			},
		],
		criterion: "雨の日だけ、毎晩15分の素振りという三条件を保持する。",
	},
];

export const evaluationControls = [...semanticControls, ...regressionControls];
