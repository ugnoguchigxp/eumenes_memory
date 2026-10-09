/** Host ownership and bounded candidate input shared by State and Extraction. */
export const MAX_EVIDENCE_PER_CANDIDATE = 4 as const;

/** ホスト（Continuity）が所有する kind。モデルが出しても候補にならない（HOST_OWNED_KIND）。 */
export const HOST_OWNED_KINDS = Object.freeze([
	"goal",
	"decision",
	"open_question",
] as const);
