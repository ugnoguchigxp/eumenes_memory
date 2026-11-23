/** Synchronous persistence operations; the host owns the transaction. */
export * from "./repository/index.ts";
export {
	rebuildStateSearchIndex,
	verifyStateSearchIndex,
} from "./repository/search-index.ts";
export type { StateSearchIndexReport } from "./repository/search-index.ts";
export {
	candidateScope,
	dismissCandidate,
	listCandidateIdsInScope,
	listCandidates,
	promoteCandidate,
	readCandidate,
	recordCandidate,
	scrubCandidate,
} from "./repository/candidates.ts";
export type { ScrubbedCandidate } from "./repository/candidates.ts";
export {
	clearStateMarks,
	decayStateStrength,
	listStateByTime,
	listSuppressions,
	reinforceStateStrength,
	releaseStateSuppression,
	suppressState,
} from "./repository/marks.ts";
