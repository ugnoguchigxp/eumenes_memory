import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { RetrievalCase } from "./cases.ts";
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const input = process.argv[2]!,
	output = process.argv[3]!,
	runnerPath = process.argv[4]!;
if (
	!input ||
	!output ||
	!runnerPath ||
	existsSync(output) ||
	existsSync(runnerPath)
)
	throw Error(
		"Usage: prepare-retrieval-v2.ts <v1-design> <new-design> <new-runner.ts>",
	);
const hash = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const original = JSON.parse(readFileSync(input, "utf8")),
	design = structuredClone(original);
const names = ["凪", "樹", "律", "葵", "悠"],
	peers = ["澪", "蓮", "奏", "梓", "環"],
	places = ["翠浜", "赤崎", "南沼", "白谷", "石浦"];
const edits: unknown[] = [];
for (const c of design.retrieval as Mutable<RetrievalCase>[]) {
	const di = (Number(c.id.slice(1)) - 1) % 5;
	const targets = new Set(
		c.items.filter((x) => x.subject === "self").map((x) => x.itemId),
	);
	const fact = (i: number) =>
		c.items.find((x) => x.semanticKey === `field-${i}`)!;
	const owner = (i: number, role: string, label: string) => {
		const x = fact(i);
		x.subject = `other:${role}`;
		x.subjectLabel = label;
		x.kind = "other_person_note";
	};
	const preference = (i: number) => {
		fact(i).kind = "preference";
	};
	switch (c.family) {
		case "direct":
			preference(0);
			owner(1, "actor", names[di]!);
			break;
		case "three-hop":
			owner(1, "actor", names[di]!);
			owner(3, "peer", peers[di]!);
			break;
		case "wrong-owner":
			owner(0, "actor", names[di]!);
			preference(1);
			break;
		case "negative":
			preference(0);
			fact(0).value.text = fact(0).value.text.replace(
				"が好きではない",
				"が好き",
			);
			fact(0).value.polarity = "negated";
			owner(1, "actor", names[di]!);
			break;
		case "quantity":
			fact(0).kind = "habit";
			owner(1, "actor", names[di]!);
			break;
		case "partial-known":
			preference(0);
			break;
		case "exception":
			fact(0).kind = "habit";
			fact(1).kind = "constraint";
			fact(1).value.text = fact(1).value.text.replace(
				"には出勤しない",
				"には出勤する",
			);
			fact(1).value.polarity = "negated";
			break;
		case "homonym":
			owner(0, "colleague", `同僚の${names[di]}`);
			owner(1, "relative", `親戚の${names[di]}`);
			break;
		case "conjunction":
			owner(0, "actor", names[di]!);
			owner(1, "actor", names[di]!);
			owner(2, "peer", peers[di]!);
			owner(3, "peer", peers[di]!);
			break;
		case "quotation":
			preference(0);
			break;
		case "relational-unknown":
			preference(0);
			break;
		case "explicit-absence":
			fact(0).value.text = fact(0).value.text.replace(
				"に入っていない",
				"に入っている",
			);
			fact(0).value.polarity = "negated";
			owner(1, "actor", names[di]!);
			break;
	}
	// Same-owner distractors remove the artificial advantage of filtering all noise by owner.
	for (const x of c.items) {
		if (targets.has(x.itemId)) continue;
		const n = Number(x.semanticKey.slice("field-".length));
		if (n % 2 === 0) {
			x.subject = "self";
			x.kind = "personal_fact";
			x.value.text = `私は2022年の旅行記録${n}で${places[n % 5]}分館${n}を見学した`;
		} else if (n % 5 === 2)
			x.value.text = x.value.text.replace(
				"別施設・施設番号",
				`登録者${n}が利用する施設番号`,
			);
	}
	const before = original.retrieval.find((x: RetrievalCase) => x.id === c.id);
	if (
		JSON.stringify(before.parts) !== JSON.stringify(c.parts) ||
		before.message !== c.message
	)
		throw Error("Gold/question changed");
	edits.push({
		id: c.id,
		changedItems: c.items
			.filter(
				(x) =>
					JSON.stringify(x) !==
					JSON.stringify(
						before.items.find((b: { itemId: string }) => b.itemId === x.itemId),
					),
			)
			.map((x) => x.itemId),
	});
}
design.version = 2;
design.parentDesignHash = hash(original);
design.amendment =
	"Correct owner/kind metadata and normalized negation; half of distractors now belong to self. Questions, gold IDs/status, model, prompts, sizes, thresholds unchanged. Add one-shot with the identical final grounding instruction as a component ablation. Original retrieval run is invalid for acceptance; retained separately.";
design.createdAt = new Date().toISOString();
let runner = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
function replaceOnce(from: string, to: string) {
	if (runner.split(from).length !== 2)
		throw Error("Runner patch no longer applies");
	runner = runner.replace(from, to);
}
replaceOnce(
	'["old", "new", "all"] : ["all", "new", "old"]',
	'["old", "new", "all", "all-grounded"] : ["all-grounded", "all", "new", "old"]',
);
replaceOnce(
	'} else if (arm === "all") {',
	'} else if (arm === "all" || arm === "all-grounded") {',
);
replaceOnce(
	'traced(clients["all"]!, calls, "all")',
	'traced(clients[arm === "all-grounded" ? "grounding" : "all"]!, calls, arm)',
);
replaceOnce(
	"JSON.stringify({ message: c.message, items: c.items })",
	'JSON.stringify({ message: c.message, items: c.items, ...(arm === "all-grounded" ? {coverage:{complete:true,scannedPages:1,totalPages:1,candidateCount:c.items.length,candidateLimit:false}} : {}) })',
);
writeFileSync(output, JSON.stringify(design, null, 2) + "\n");
writeFileSync(runnerPath, runner);
writeFileSync(
	output + ".manifest.json",
	JSON.stringify(
		{
			designHash: hash(design),
			parentDesignHash: hash(original),
			runnerSha256: createHash("sha256").update(runner).digest("hex"),
			edits,
		},
		null,
		2,
	) + "\n",
);
console.log(
	JSON.stringify({
		designHash: hash(design),
		questions: 100,
		goldChanged: false,
		arms: 4,
	}),
);
