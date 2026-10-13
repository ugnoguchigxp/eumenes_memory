/** 入力上限。単位は UTF-8 byte または個数。 */
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
	maxSourceContentBytes: 1048576,
	maxTotalSourceContentBytes: 16777216,
});

export const SOURCE_STATUSES = Object.freeze([
	"available",
	"missing",
	"changed",
	"forgotten",
] as const);
