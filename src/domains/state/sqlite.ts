/** Synchronous persistence operations; the host owns the transaction. */
export * from "./repository/index.ts";
export {
	rebuildStateSearchIndex,
	verifyStateSearchIndex,
} from "./repository/search-index.ts";
export type { StateSearchIndexReport } from "./repository/search-index.ts";
