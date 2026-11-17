import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { verifyForgetJournal, type ForgetJournalEntry } from "eumenes-memory";
import { demand, HostError, type HostConfig } from "./contracts.ts";

export type RecoveryConfig = NonNullable<HostConfig["recovery"]>;

export function syncPath(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** A private, durable replacement. Flush both the file and its directory entry. */
export function writePrivateFile(
	directory: string,
	path: string,
	content: string,
): void {
	const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
		syncPath(temp);
		renameSync(temp, path);
		syncPath(directory);
	} finally {
		rmSync(temp, { force: true });
	}
}

function receiptPath(root: string, config: RecoveryConfig): string {
	const directory = realpathSync(config.directory);
	const fromRoot = relative(realpathSync(root), directory);
	demand(
		fromRoot === ".." ||
			fromRoot.startsWith(`..${sep}`) ||
			isAbsolute(fromRoot),
		"RECOVERY_DIRECTORY_INSIDE_STORE",
	);
	const stat = lstatSync(directory);
	demand(
		stat.isDirectory() && (stat.mode & 0o077) === 0,
		"RECOVERY_DIRECTORY_NOT_PRIVATE",
	);
	return join(directory, `forget-head-${config.storeId}.json`);
}

/** The protected location is the recency authority. It contains no memory text. */
export function writeRecoveryHead(
	root: string,
	config: RecoveryConfig,
	entry: ForgetJournalEntry | null,
): void {
	const path = receiptPath(root, config);
	writePrivateFile(
		realpathSync(config.directory),
		path,
		JSON.stringify({
			version: 1,
			storeId: config.storeId,
			entry,
		}) + "\n",
	);
}

export function readRecoveryHead(
	root: string,
	config: RecoveryConfig,
): ForgetJournalEntry | null {
	try {
		const path = receiptPath(root, config);
		const stat = lstatSync(path);
		demand(
			stat.isFile() && (stat.mode & 0o077) === 0,
			"JOURNAL_HEAD_UNVERIFIED",
		);
		const receipt = JSON.parse(readFileSync(path, "utf8"));
		demand(
			receipt?.version === 1 &&
				receipt.storeId === config.storeId &&
				(receipt.entry === null ||
					(Number.isSafeInteger(receipt.entry?.seq) &&
						receipt.entry.seq > 0 &&
						typeof receipt.entry.hash === "string")),
			"JOURNAL_HEAD_UNVERIFIED",
		);
		return receipt.entry;
	} catch {
		throw new HostError("JOURNAL_HEAD_UNVERIFIED");
	}
}

/**
 * A forget writes its next entry to protected storage before appending locally.
 * The only recoverable mismatch is that one interrupted append, including a torn tail.
 */
export function journalWithRecoveryHead(
	raw: string,
	receipt: ForgetJournalEntry | null,
): { entries: ForgetJournalEntry[]; pending: boolean } {
	const lines = raw.split("\n");
	const tail = lines.pop() ?? "";
	let entries: ForgetJournalEntry[];
	try {
		entries = lines.filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		throw new HostError("JOURNAL_INVALID");
	}
	const last = entries.at(-1);
	const seq = last?.seq ?? 0;
	if (receipt?.seq === seq + 1) {
		demand(JSON.stringify(receipt).startsWith(tail), "JOURNAL_HEAD_UNVERIFIED");
		entries.push(receipt);
	} else {
		demand(
			!tail &&
				(receipt?.seq ?? 0) === seq &&
				receipt?.hash === last?.hash &&
				JSON.stringify(receipt) === JSON.stringify(last ?? null),
			"JOURNAL_HEAD_UNVERIFIED",
		);
	}
	demand(verifyForgetJournal(entries).status === "ok", "JOURNAL_INVALID");
	return { entries, pending: entries.length !== seq };
}
