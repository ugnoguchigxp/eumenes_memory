/** Admission 規則表の fixture（S3）。親が test/fixtures.test.ts に登録するまでは、このファイルが単独で走らせる。 */
import {
	effectiveCandidateKind,
	evaluateAdmission,
} from "../../src/state/admission.ts";
import { describeAdmissionFixtures } from "../runners/admission-fixture-runner.ts";

describeAdmissionFixtures({ evaluateAdmission, effectiveCandidateKind });
