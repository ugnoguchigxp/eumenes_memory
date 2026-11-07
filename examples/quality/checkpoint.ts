/** Shared evaluation persistence: durable replacement under a fail-closed run lock. */
import {
	closeSync,
	fsyncSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function saveCheckpoint(path: string, data: unknown): void {
	const fd = openSync(path + ".tmp", "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(path + ".tmp", path);
	const directoryFd = openSync(dirname(path), "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}

export function acquireRunLock(
	directory: string,
	filename: string,
): () => void {
	const path = join(directory, filename);
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw Error(
				"Evaluation run already active or unconfirmed; inspect evidence before removing its lock",
			);
		throw error;
	}
	return () => {
		closeSync(fd);
		unlinkSync(path);
	};
}
