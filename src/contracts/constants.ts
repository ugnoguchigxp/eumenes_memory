export const SCHEMA_VERSION = 1 as const;

/** 入力上限。単位は UTF-8 byte または個数（設計書 §3.1）。 */
export const LIMITS = Object.freeze({
	maxPrincipalBytes: 256,
	maxScopeKeyBytes: 256,
	maxScopeKeys: 64,
	maxPurposeBytes: 64,
	maxRevisionBytes: 256,
	maxNamespaceBytes: 64,
	maxSourceKindBytes: 64,
	maxSourceIdBytes: 256,
	maxRepresentationBytes: 64,
	maxItemIdBytes: 256,
	maxItemTextBytes: 16384,
	maxSourceContentBytes: 1048576,
	maxTotalSourceContentBytes: 16777216,
	maxSources: 4096,
	maxItems: 1000,
	maxDependenciesPerItem: 32,
	/** coverage.omitted は M0 では常に空。巨大配列を全走査しないための小さな上限。 */
	maxCoverageOmitted: 16,
});

export const ITEM_KINDS = Object.freeze([
	"goal",
	"decision",
	"open_question",
] as const);
export const ITEM_STATUSES = Object.freeze(["active", "inactive"] as const);
export const ITEM_ORIGINS = Object.freeze([
	"user_confirmed",
	"user_edited",
] as const);
export const SOURCE_STATUSES = Object.freeze([
	"available",
	"missing",
	"changed",
	"forgotten",
] as const);
