import type { EvidencePart } from "../../standalone/support.ts";
import type { RecallCase } from "./cases.ts";
export function score(parts: EvidencePart[], expected: RecallCase["parts"]) {
	const partPasses = expected.map((p, i) => {
		const actual = parts[i];
		return Boolean(
			actual &&
			actual.status === p.status &&
			p.requiredIds.every((id) => actual.evidenceIds.includes(id)) &&
			actual.evidenceIds.every((id) => p.allowedIds.includes(id)),
		);
	});
	return {
		passed: parts.length === expected.length && partPasses.every(Boolean),
		partPasses,
	};
}
