/** New answer generalization fixtures; labels are authored before live evaluation. */
import { createHash } from "node:crypto";
import type { RecallCase } from "../experiments/one-shot-holdout/cases.ts";
type Fact = { text: string; owner?: string; negated?: boolean };
function make(
	id: string,
	family: string,
	message: string,
	facts: Fact[],
	status: "supported" | "unknown" | "conflict",
	evidence: number[],
): RecallCase {
	const items = facts.map((fact, i) => ({
		itemId: createHash("sha256")
			.update(`${id}:${i}`)
			.digest("hex")
			.slice(0, 20),
		revision: 1,
		subject: fact.owner ? (`other:${fact.owner}` as const) : ("self" as const),
		subjectLabel: fact.owner ?? "本人",
		kind: fact.owner
			? ("other_person_note" as const)
			: ("personal_fact" as const),
		semanticKey: `claim-${i}`,
		value: {
			text: fact.text,
			polarity: fact.negated ? ("negated" as const) : ("affirmed" as const),
		},
	}));
	const ids = evidence.map((i) => items[i]!.itemId);
	return {
		id,
		family,
		message,
		items,
		parts: [{ status, requiredIds: ids, allowedIds: ids }],
	};
}
export const answerGeneralizationCases = [
	make(
		"A001",
		"unestablished_identity",
		"私と同僚は同じ建物に住んでいる？",
		[{ owner: "同僚", text: "青波荘に住んでいる" }],
		"unknown",
		[],
	),
	make(
		"A002",
		"unestablished_difference",
		"私は弟とは別の電話番号を使う？",
		[{ owner: "弟", text: "連絡先は090-0000-1234" }],
		"unknown",
		[],
	),
	make(
		"A003",
		"explicit_shared_relation",
		"私が姉と一緒に借りている部屋番号は？",
		[
			{ owner: "姉", text: "借りている部屋は602号室" },
			{ text: "私は姉と同じ部屋を共同で借りている" },
		],
		"supported",
		[0, 1],
	),
	make(
		"A004",
		"missing_rule_condition",
		"この荷物は持ち込める？",
		[{ text: "20kg以下の荷物だけ持ち込める" }],
		"unknown",
		[],
	),
	make(
		"A005",
		"posed_rule_condition",
		"出発の5日前ですが予約を変更できる？",
		[{ text: "予約変更は出発の3日前まで受け付ける" }],
		"supported",
		[0],
	),
	make(
		"A006",
		"unresolved_transition",
		"会員区分を変更したことはある？",
		[{ text: "現在の会員区分は一般" }, { text: "現在の会員区分は学生" }],
		"unknown",
		[],
	),
	make(
		"A007",
		"known_time_conflict",
		"来週火曜の面談開始は何時？",
		[
			{ text: "来週火曜の面談は10時開始" },
			{ text: "来週火曜の面談は14時開始" },
		],
		"conflict",
		[0, 1],
	),
	make(
		"A008",
		"explicit_difference",
		"私は同僚と同じ勤務先？",
		[{ text: "私は同僚とは異なる会社で勤務している" }],
		"supported",
		[0],
	),
	make(
		"A009",
		"denied_universal",
		"私は毎晩外食する？",
		[{ text: "私は毎晩自炊する", negated: true }],
		"unknown",
		[],
	),
	make(
		"A010",
		"known_exception",
		"診療中でも緊急連絡を受けられる？",
		[
			{ text: "診療中は連絡を受けない" },
			{ text: "診療中でも緊急連絡だけは受ける" },
		],
		"supported",
		[0, 1],
	),
	make(
		"A011",
		"partial_unknown",
		"私の担当部署と在籍年数は？",
		[{ text: "担当部署は調達部" }],
		"supported",
		[0],
	),
	make(
		"A012",
		"explicit_precedence",
		"現在の配送先は？",
		[{ text: "以前の配送先は北町" }, { text: "配送先を訂正し、現在は西町" }],
		"supported",
		[1],
	),
];
// Two requested slots must remain distinct even when one lacks evidence.
answerGeneralizationCases[10]!.parts.push({
	status: "unknown",
	requiredIds: [],
	allowedIds: [],
});
