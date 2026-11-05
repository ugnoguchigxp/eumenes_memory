import { expect, test } from "bun:test";
import {
	calibrationCases,
	parseAnswerJudge,
} from "../../examples/quality/answers.ts";
test("calibration fixes40 labels before live use with balanced correct/unsafe controls", () => {
	expect(calibrationCases).toHaveLength(40);
	expect(calibrationCases.filter((x) => x.expected)).toHaveLength(20);
	expect(new Set(calibrationCases.map((x) => x.id)).size).toBe(40);
	for (const x of calibrationCases) {
		expect(x.question).not.toBe("");
		expect(x.answer).not.toBe("");
	}
});
test("answer judgment rejects contradictory verdicts and missing or ungrounded fields", () => {
	expect(
		parseAnswerJudge('{"faithful":true,"violations":[],"reason":"supported"}')
			.faithful,
	).toBe(true);
	for (const raw of [
		"{}",
		'{"faithful":true,"violations":["unsupported"],"reason":"x"}',
		'{"faithful":false,"violations":[],"reason":"x"}',
		'{"faithful":false,"violations":[""],"reason":"x"}',
	])
		expect(() => parseAnswerJudge(raw)).toThrow();
});
