import { Database } from "bun:sqlite";
import { join } from "node:path";
import { HostError } from "./contracts.ts";

/** The same lock excludes serving, restoring and switching a standalone store. */
export function acquireOwnerLock(directory: string): Database {
	const lock = new Database(join(directory, "owner.lock"));
	try {
		lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
		return lock;
	} catch {
		lock.close();
		throw new HostError("OWNER_ALREADY_RUNNING");
	}
}
