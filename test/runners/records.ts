/** fixtures/evidence の実行（Records: capture / read / range / revision / forget / access）。 */
import { describe, test } from "bun:test";
import { loadFixtures } from "../fixture-runner.ts";
import { runSteps } from "./steps.ts";
import type { StepsApi } from "./steps.ts";

export function describeRecordsFixtures(api: StepsApi): void {
	describe("evidence fixtures (Records, real SQLite)", () => {
		for (const fixture of loadFixtures("evidence")) {
			test(String(fixture["id"]), () => {
				runSteps(fixture, api);
			});
		}
	});
}
