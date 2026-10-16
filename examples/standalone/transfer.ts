import type { ExpectedFact, Scenario } from "./scenarios.ts";

const self = (
	text: string,
	kind: ExpectedFact["kind"] = "preference",
): ExpectedFact => ({ text, kind, subject: "self", polarity: "affirmed" });
const other = (subject: `other:${string}`, text: string): ExpectedFact => ({
	text,
	subject,
	kind: "other_person_note",
	polarity: "affirmed",
});
const leisureMessage =
	"私の息抜きはガラス細工です。指の体操は毎晩5分続けています。両方覚えて。";
const mixedMessage =
	"アイナが余暇に楽しんでいるのは版画です。ソラは版画に少し興味があるそうです。二人の情報として覚えて。";
const firstMessage = "イトの気晴らしは盆栽です。覚えておいて。";
const updateMessage =
	"イトの気晴らしは、盆栽ではなく写真でした。そちらに直して。";
const glass = self("ガラス細工が趣味");
const fingers = self("毎晩5分、指の体操をする", "habit");
const aina = other("other:aina", "版画が趣味");
const sora = other("other:sora", "版画に少し興味がある");
const bonsai = other("other:ito", "盆栽が趣味");
const photography = other("other:ito", "写真が趣味");

/** New inputs and gold declared before v21 live testing; no wording-specific host logic. */
export const transferScenarios: Scenario[] = [
	{
		id: "transfer-recreation-synonym",
		description:
			"息抜きの別表現と毎晩の習慣を分け、未提供の趣味頻度には答えない",
		steps: [
			{
				task: "decide",
				message: leisureMessage,
				expected: [glass, fingers],
				expectedActions: { remember: 2, forget: 0 },
				replay: {
					actions: [
						{
							type: "remember",
							subject: "self",
							kind: "preference",
							semanticKey: "leisure",
							value: { text: glass.text, polarity: "affirmed" },
							quote: leisureMessage,
							replacesItemId: null,
						},
						{
							type: "remember",
							subject: "self",
							kind: "habit",
							semanticKey: "routine",
							value: { text: fingers.text, polarity: "affirmed" },
							quote: leisureMessage,
							replacesItemId: null,
						},
					],
				},
			},
			{
				task: "recall",
				message: "私の息抜きと毎晩の習慣で、覚えている両方を教えて。",
				expected: [glass, fingers],
				replay: { itemIds: ["$key:leisure", "$key:routine"] },
				restart: true,
			},
			{
				task: "recall",
				message: "ガラス細工は週に何回やっていますか？",
				expected: [],
				replay: { itemIds: [] },
			},
		],
	},
	{
		id: "transfer-other-leisure-curiosity",
		description:
			"別人物の余暇と弱い関心を強めず保持し、一人の忘却後にも残る他者だけを返す",
		subjects: [
			{ id: "other:aina", label: "友人のアイナ" },
			{ id: "other:sora", label: "親戚のソラ" },
		],
		steps: [
			{
				task: "decide",
				message: mixedMessage,
				expected: [aina, sora],
				expectedActions: { remember: 2, forget: 0 },
				replay: {
					actions: [
						{
							type: "remember",
							subject: "other:aina",
							kind: "other_person_note",
							semanticKey: "leisure",
							value: { text: aina.text, polarity: "affirmed" },
							quote: mixedMessage,
							replacesItemId: null,
						},
						{
							type: "remember",
							subject: "other:sora",
							kind: "other_person_note",
							semanticKey: "curiosity",
							value: { text: sora.text, polarity: "affirmed" },
							quote: mixedMessage,
							replacesItemId: null,
						},
					],
				},
			},
			{
				task: "recall",
				message: "アイナとソラについて記憶している情報をそれぞれ教えて。",
				expected: [aina, sora],
				replay: { itemIds: ["$key:leisure", "$key:curiosity"] },
			},
			{
				task: "decide",
				message: "アイナの版画の話だけ忘れて。ソラの話は残して。",
				expected: [sora],
				expectedActions: { remember: 0, forget: 1 },
				replay: { actions: [{ type: "forget", itemId: "$key:leisure" }] },
				restoreBeforeForget: true,
			},
			{
				task: "recall",
				message: "ソラの版画の腕前は、どのくらいですか？",
				expected: [],
				replay: { itemIds: [] },
			},
			{
				task: "recall",
				message: "二人について今も覚えている情報を教えて。",
				expected: [sora],
				replay: { itemIds: ["$key:curiosity"] },
				restart: true,
			},
		],
	},
	{
		id: "transfer-contrast-recreation",
		description:
			"気晴らしの名詞述語を理解し、対比を伴う訂正で以前の対象への嫌悪を追加しない",
		subjects: [{ id: "other:ito", label: "同僚のイト" }],
		steps: [
			{
				task: "decide",
				message: firstMessage,
				expected: [bonsai],
				expectedActions: { remember: 1, forget: 0 },
				replay: {
					actions: [
						{
							type: "remember",
							subject: "other:ito",
							kind: "other_person_note",
							semanticKey: "leisure",
							value: { text: bonsai.text, polarity: "affirmed" },
							quote: firstMessage,
							replacesItemId: null,
						},
					],
				},
			},
			{
				task: "decide",
				message: updateMessage,
				expected: [photography],
				expectedActions: { remember: 1, forget: 0 },
				replay: {
					actions: [
						{
							type: "remember",
							subject: "other:ito",
							kind: "other_person_note",
							semanticKey: "leisure",
							value: { text: photography.text, polarity: "affirmed" },
							quote: updateMessage,
							replacesItemId: "$key:leisure",
						},
					],
				},
			},
			{
				task: "recall",
				message: "イトの趣味で今覚えていることは？",
				expected: [photography],
				replay: { itemIds: ["$key:leisure"] },
				restart: true,
			},
		],
	},
];
