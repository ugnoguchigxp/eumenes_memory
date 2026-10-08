/** State 台帳の純粋部品の fixture（S3）。親が test/fixtures.test.ts に登録するまでは、このファイルが単独で走らせる。 */
import { applyStateTransition } from "../../src/state/reducer.ts";
import { describeStateFixtures } from "../runners/state-fixture-runner.ts";

describeStateFixtures({ applyStateTransition });
