import { canonicalJson } from "../src/canonical/json.ts";
import { sha256Hex } from "../src/canonical/sha256.ts";
import {
	encodeUtf8,
	isUtf8CharBoundary,
	utf8ByteLength,
} from "../src/canonical/utf8.ts";
import { buildMemoryView } from "../src/view/build.ts";
import { validateMemoryView } from "../src/validation/validate.ts";
import { validateMemoryViewV2 } from "../src/validation/validate-v2.ts";
import { buildMemoryViewV2 } from "../src/view/build-v2.ts";
import {
	describeInternalFixtures,
	describePublicFixtures,
	describePublicFixturesV2,
} from "./fixture-runner.ts";

describeInternalFixtures({
	canonicalJson,
	sha256Hex,
	utf8ByteLength,
	encodeUtf8,
	isUtf8CharBoundary,
});

describePublicFixtures("internal", { buildMemoryView, validateMemoryView });
describePublicFixturesV2("internal", {
	buildMemoryViewV2,
	validateMemoryViewV2,
});
