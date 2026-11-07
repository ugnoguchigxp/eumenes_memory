/** Fixed-gold diagnostics, separate from storage correctness and prose-answer judgments. */
import type { RecallCase } from "../experiments/one-shot-holdout/cases.ts";
import type { EvidencePart } from "../standalone/support.ts";
import { score } from "../experiments/one-shot-holdout/score.ts";

export interface RetrievalObservation {
	expected: RecallCase["parts"];
	actual?: EvidencePart[];
}

const rate = (numerator: number, denominator: number) => ({
	numerator,
	denominator,
	rate: denominator ? numerator / denominator : null,
});

export function retrievalMetrics(rows: readonly RetrievalObservation[]) {
	let unavailableCases = 0,
		unalignedCases = 0,
		unalignedSupportedParts = 0;
	let expectedParts = 0,
		alignedParts = 0,
		expectedNonSupported = 0;
	let expectedSupported = 0,
		returnedSupported = 0,
		falseSupported = 0;
	let supportedEvidenceMismatch = 0,
		unnecessaryUnknown = 0,
		missedSupported = 0;
	const confusion = {
		supported: { supported: 0, unknown: 0, conflict: 0 },
		unknown: { supported: 0, unknown: 0, conflict: 0 },
		conflict: { supported: 0, unknown: 0, conflict: 0 },
	};
	for (const { expected, actual } of rows) {
		expectedParts += expected.length;
		if (!actual) {
			unavailableCases++;
			continue;
		}
		// A split/merge shifts the slots. Do not guess an alignment or dilute the denominator.
		if (actual.length !== expected.length) {
			unalignedCases++;
			unalignedSupportedParts += actual.filter(
				(p) => p.status === "supported",
			).length;
			continue;
		}
		const grade = score(actual, expected);
		for (const [i, gold] of expected.entries()) {
			const part = actual[i]!;
			alignedParts++;
			confusion[gold.status][part.status]++;
			if (gold.status === "supported") {
				expectedSupported++;
				if (part.status !== "supported") missedSupported++;
				if (part.status === "unknown") unnecessaryUnknown++;
			} else expectedNonSupported++;
			if (part.status === "supported") {
				returnedSupported++;
				if (gold.status !== "supported") falseSupported++;
				else if (!grade.partPasses[i]) supportedEvidenceMismatch++;
			}
		}
	}
	return {
		cases: rows.length,
		unavailableCases,
		unalignedCases,
		unalignedSupportedParts,
		expectedParts,
		alignedParts,
		confusion,
		falseSupported: rate(falseSupported, expectedNonSupported),
		supportedEvidenceMismatch: rate(
			supportedEvidenceMismatch,
			returnedSupported,
		),
		unsupportedAmongSupportedByGold: rate(
			falseSupported + supportedEvidenceMismatch,
			returnedSupported,
		),
		unnecessaryUnknown: rate(unnecessaryUnknown, expectedSupported),
		missedSupported: rate(missedSupported, expectedSupported),
		limits: [
			"Status and evidence selection against fixed gold, not prose-answer or real-user accuracy.",
			"Equal-length outputs are aligned by question order; slot meaning requires semantic review.",
			"Evidence mismatch may include a valid alternative outside the frozen gold; review separately, never relabel silently.",
			"Unavailable and different-length outputs stay explicit and are excluded from slot-rate denominators.",
		],
	};
}
