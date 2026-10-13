/** State の永続テスト用の入力ビルダー（テスト専用）。 */
import { sha256Hex } from "../../../canonical/sha256.ts";
import type { EvidenceSpan } from "../../../contracts/common.ts";
import type {
	AssertUserStateInput,
	HostSourceState,
	StateTargetInput,
	StateValue,
} from "../contracts/index.ts";
import type { AccessContext } from "../../../contracts/types.ts";

export const SCOPE = "conversation:c1";
export const OTHER_SCOPE = "conversation:c2";
export const ACCESS: AccessContext = {
	principal: "local:owner",
	scopeKeys: [SCOPE, OTHER_SCOPE],
	purpose: "state.write",
	policyRevision: "1",
};

export function makeSource(
	id: string,
	content: string,
	ordinal: number,
	overrides: Partial<HostSourceState> = {},
	scopeKey: string = SCOPE,
): HostSourceState {
	const digest = sha256Hex(content);
	return {
		namespace: "conversation",
		kind: "message",
		id,
		representation: "text",
		revision: `sha256:${digest}`,
		digest,
		principal: ACCESS.principal,
		scopeKey,
		status: "available",
		content,
		ordinal,
		...overrides,
	};
}

/** `locate`（既定は quote）の最初の出現の UTF-8 byte 範囲を range にした根拠。 */
export function makeSpan(
	source: HostSourceState,
	quote: string,
	locate: string = quote,
): EvidenceSpan {
	const content = source.content;
	const index = content.indexOf(locate);
	if (index < 0) throw new Error("locate not found");
	const start = Buffer.byteLength(content.slice(0, index), "utf8");
	return {
		source: {
			namespace: source.namespace,
			kind: source.kind,
			id: source.id,
			...(Object.hasOwn(source, "representation")
				? { representation: source.representation as string }
				: {}),
			revision: source.revision,
			digest: source.digest,
			range: {
				startByte: start,
				endByte: start + Buffer.byteLength(locate, "utf8"),
			},
		},
		quote,
	};
}

export const COFFEE = makeSource("m1", "私はコーヒーが好きです。", 5);
export const TEA = makeSource("m2", "最近は紅茶が好きになった。", 8);
export const OLD = makeSource("m0", "昔は緑茶が好きだった。", 1);

export function value(
	text: string,
	polarity: "affirmed" | "negated" = "affirmed",
	attributes?: Record<string, string>,
): StateValue {
	return {
		text,
		polarity,
		...(attributes === undefined ? {} : { attributes }),
	};
}

export function assertInput(
	overrides: Partial<AssertUserStateInput> = {},
): AssertUserStateInput {
	return {
		contractVersion: 1,
		access: ACCESS,
		scopeKey: SCOPE,
		clock: { atMs: 1000 },
		kind: "preference",
		subject: "self",
		semanticKey: "drink",
		value: value("コーヒーが好き"),
		evidence: [makeSpan(COFFEE, "コーヒーが好き")],
		sources: [COFFEE],
		origin: "user_confirmed",
		...overrides,
	};
}

export function targetInput(
	itemId: string,
	expectedRevision: number,
	overrides: Partial<StateTargetInput> = {},
): StateTargetInput {
	return {
		contractVersion: 1,
		access: ACCESS,
		scopeKey: SCOPE,
		clock: { atMs: 3000 },
		itemId,
		expectedRevision,
		...overrides,
	};
}
