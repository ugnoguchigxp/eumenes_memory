/** fixtures/recall の実行（Recall: LIKE / FTS の同値、scope、cursor、forget）。 */
import { describe, test } from "bun:test";
import { loadFixtures } from "../fixture-runner.ts";
import { runSteps } from "./steps.ts";
import type { StepsApi } from "./steps.ts";

export function describeRecallFixtures(api: StepsApi): void {
	describe("recall fixtures (Recall, real SQLite)", () => {
		for (const fixture of loadFixtures("recall")) {
			test(String(fixture["id"]), () => {
				runSteps(fixture, api);
			});
		}
	});
}
