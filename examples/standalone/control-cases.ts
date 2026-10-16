import type { EvaluationGroup } from "./model-input.ts";
export interface SemanticControl {
	name: string;
	expectedPassed: boolean;
	groups: EvaluationGroup[];
}
// First six controls preserve v18 inputs and verdicts; later cases test stronger boundaries.
export const semanticControls: SemanticControl[] = [
	{
		name: "paraphrase-with-owner-metadata",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "other:rio-probe",
				subjectLabel: "知人の梨央",
				kind: "other_person_note",
				polarity: "affirmed",
				actual: ["社員番号はQ17である"],
				expected: ["社員番号がQ17"],
			},
		],
	},
	{
		name: "different-value",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "other:rio-probe",
				subjectLabel: "知人の梨央",
				kind: "other_person_note",
				polarity: "affirmed",
				actual: ["社員番号はQ71である"],
				expected: ["社員番号がQ17"],
			},
		],
	},
	{
		name: "negated-paraphrase",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				polarity: "negated",
				actual: ["抹茶が好きである"],
				expected: ["抹茶"],
			},
		],
	},
	{
		name: "missing-frequency",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["自転車で通勤する"],
				expected: ["週に3回、自転車で通勤する"],
			},
		],
	},
	{
		name: "missing-exclusive-condition",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["平日に週4回、1回20分ずつ発声練習をする"],
				expected: ["平日だけ、週4回、1回20分ずつ発声練習をする"],
			},
		],
	},
	{
		name: "future-event-is-not-enduring-interest",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "other:mina-probe",
				kind: "other_person_note",
				polarity: "affirmed",
				subjectLabel: "隣人のミナ",
				actual: ["来週の料理体験を楽しみにしている"],
				expected: ["料理が趣味"],
			},
		],
	},
	{
		name: "opposite-inner-predicate",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				polarity: "negated",
				actual: ["抹茶が嫌いである"],
				expected: ["抹茶"],
			},
		],
	},
	{
		name: "reverse-exclusive-condition",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["平日だけ、週4回、1回20分ずつ発声練習をする"],
				expected: ["平日に週4回、1回20分ずつ発声練習をする"],
			},
		],
	},
	{
		name: "preserved-exclusive-condition",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "habit",
				polarity: "affirmed",
				actual: ["平日に限って、週4回、1回20分ずつ発声練習をする"],
				expected: ["平日だけ、週4回、1回20分ずつ発声練習をする"],
			},
		],
	},
	{
		name: "negative-copula-and-owner-paraphrase",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "self",
				kind: "preference",
				polarity: "negated",
				actual: ["私はパクチーが好きです"],
				expected: ["パクチーが好き"],
			},
		],
	},
	{
		name: "nominal-leisure-relation",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "other:probe-leisure",
				subjectLabel: "親戚のカイ",
				kind: "other_person_note",
				polarity: "affirmed",
				actual: ["余暇の楽しみは篆刻です"],
				expected: ["篆刻が趣味"],
			},
		],
	},
	{
		name: "mere-curiosity-is-weaker",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "other:probe-leisure",
				subjectLabel: "親戚のカイ",
				kind: "other_person_note",
				polarity: "affirmed",
				actual: ["篆刻に興味がある"],
				expected: ["篆刻が趣味"],
			},
		],
	},
	{
		name: "specific-event-anticipation",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "other:probe-leisure",
				subjectLabel: "親戚のカイ",
				kind: "other_person_note",
				polarity: "affirmed",
				actual: ["来月の篆刻教室を楽しみにしている"],
				expected: ["篆刻が趣味"],
			},
		],
	},
	{
		name: "added-ranking-is-not-neutral",
		expectedPassed: false,
		groups: [
			{
				groupId: "g0",
				subject: "other:probe-leisure",
				subjectLabel: "親戚のカイ",
				kind: "other_person_note",
				polarity: "affirmed",
				actual: ["一番の楽しみは切り絵です"],
				expected: ["切り絵が趣味"],
			},
		],
	},
	{
		name: "nominal-recreation-synonym",
		expectedPassed: true,
		groups: [
			{
				groupId: "g0",
				subject: "other:probe-emi",
				subjectLabel: "近所のエミ",
				kind: "other_person_note",
				polarity: "affirmed",
				actual: ["気晴らしはクイズです"],
				expected: ["クイズが趣味"],
			},
		],
	},
];
