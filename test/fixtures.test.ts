import { canonicalJson } from "../src/canonical/json.ts";
import { sha256Hex } from "../src/canonical/sha256.ts";
import {
	encodeUtf8,
	isUtf8CharBoundary,
	utf8ByteLength,
} from "../src/canonical/utf8.ts";
import { describeInternalFixtures } from "./fixture-runner.ts";

describeInternalFixtures({
	canonicalJson,
	sha256Hex,
	utf8ByteLength,
	encodeUtf8,
	isUtf8CharBoundary,
});
