import type { StateItem, StateSubject } from "eumenes-memory";

export type ModelItem = Pick<
	StateItem,
	"itemId" | "revision" | "subject" | "kind" | "semanticKey" | "value"
> &
	Partial<Pick<StateItem, "validFromMs" | "validUntilMs" | "validity">> & {
		subjectLabel?: string;
	};

/** Join identities by exact ID. Interpretation and selection remain entirely with the model. */
export function modelItems(
	items: readonly StateItem[],
	subjects: readonly { id: StateSubject; label: string }[] = [],
): ModelItem[] {
	const labels = new Map(
		subjects.map((subject) => [subject.id, subject.label]),
	);
	return items.map(
		({
			itemId,
			revision,
			subject,
			kind,
			semanticKey,
			value,
			validFromMs,
			validUntilMs,
			validity,
		}) => {
			const subjectLabel = labels.get(subject);
			return {
				itemId,
				revision,
				subject,
				kind,
				semanticKey,
				value,
				...(validFromMs === null ? {} : { validFromMs }),
				...(validUntilMs === null ? {} : { validUntilMs }),
				...(validity === undefined ? {} : { validity }),
				...(subjectLabel === undefined ? {} : { subjectLabel }),
			};
		},
	);
}

export interface ComparableFact {
	subject: StateItem["subject"];
	kind: StateItem["kind"];
	polarity: StateItem["value"]["polarity"];
	text: string;
}
export interface EvaluationGroup {
	groupId: string;
	subject: ComparableFact["subject"];
	kind: ComparableFact["kind"];
	polarity: ComparableFact["polarity"];
	subjectLabel?: string;
	actual: string[];
	expected: string[];
}

/** Group by exact contract fields, never by wording or semantic similarity. */
export function evaluationGroups(
	actual: readonly ComparableFact[],
	expected: readonly ComparableFact[],
	subjects: readonly { id: StateSubject; label: string }[] = [],
): EvaluationGroup[] {
	const groups = new Map<string, Omit<EvaluationGroup, "groupId">>();
	const labels = new Map(
		subjects.map((subject) => [subject.id, subject.label]),
	);
	const group = (fact: ComparableFact) => {
		const key = JSON.stringify([fact.subject, fact.kind, fact.polarity]);
		let value = groups.get(key);
		if (value === undefined) {
			const label = labels.get(fact.subject);
			value = {
				subject: fact.subject,
				kind: fact.kind,
				polarity: fact.polarity,
				actual: [],
				expected: [],
				...(label === undefined ? {} : { subjectLabel: label }),
			};
			groups.set(key, value);
		}
		return value;
	};
	for (const fact of actual) group(fact).actual.push(fact.text);
	for (const fact of expected) group(fact).expected.push(fact.text);
	return [...groups.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, value], index) => ({ groupId: `g${index}`, ...value }));
}
