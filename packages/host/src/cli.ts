#!/usr/bin/env bun
import { join } from "node:path";
import { readBoundedText } from "./io.ts";
import { exitCode, failure, HOST_LIMITS, HostError } from "./contracts.ts";
import { initialize, protectJournal } from "./storage.ts";
import {
	readProfile,
	request,
	restoreStore,
	startStandalone,
} from "./transport.ts";
import { natural } from "./natural.ts";
import { serveMemoryMcp } from "./mcp.ts";

const usage = `Usage:
  eumenes-memory init <directory> [scope ...] [--backups <directory>]
  eumenes-memory serve <directory>
  eumenes-memory protect-journal <directory> <protected-directory>   (server must be stopped)
  eumenes-memory restore <backup.db> <directory>   (server must be stopped)
  eumenes-memory --profile <profile.json> mcp
  eumenes-memory --profile <profile.json> status|source|context|search|read|plan|apply|operation|use|recall|recall-size --input <file|->
  eumenes-memory --profile <profile.json> backup|expire
  eumenes-memory --profile <profile.json> review [--input <file|->]   (read-only review list, at most 20)
  eumenes-memory --profile <profile.json> reactivate --input <file|->   ({"itemId": ...}, admin)
All operation output is JSON. plan validates only; apply performs mutations.
`;
export async function main(raw: string[]): Promise<void> {
	const args = [...raw];
	if (!args.length || args.includes("--help")) {
		console.log(usage);
		return;
	}
	let profilePath: string | undefined;
	const pi = args.indexOf("--profile");
	if (pi >= 0) {
		profilePath = args[pi + 1];
		args.splice(pi, 2);
	}
	let command = args.shift();
	if (command === "forget") {
		command = args.shift();
		if (command !== "plan" && command !== "apply")
			throw new HostError("INVALID_ARGUMENTS");
	}
	if (command === "init") {
		const directory = args.shift();
		if (!directory) throw new HostError("DIRECTORY_REQUIRED");
		let backupDirectory: string | undefined;
		const bi = args.indexOf("--backups");
		if (bi >= 0) {
			backupDirectory = args[bi + 1];
			if (!backupDirectory) throw new HostError("INVALID_ARGUMENTS");
			args.splice(bi, 2);
		}
		initialize(
			directory,
			args.length ? args : ["personal"],
			backupDirectory ? { backupDirectory } : {},
		);
		console.log(
			JSON.stringify({
				status: "ready",
				profile: join(directory, "profile.json"),
			}),
		);
		return;
	}
	if (command === "protect-journal") {
		const [directory, protectedDirectory, ...rest] = args;
		if (!directory || !protectedDirectory || rest.length)
			throw new HostError("INVALID_ARGUMENTS");
		protectJournal(directory, protectedDirectory);
		console.log(JSON.stringify({ status: "completed" }));
		return;
	}
	if (command === "restore") {
		const [backup, directory, ...rest] = args;
		if (!backup || !directory || rest.length)
			throw new HostError("INVALID_ARGUMENTS");
		const result = await restoreStore(backup, directory);
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = exitCode(result);
		return;
	}
	if (command === "serve") {
		const directory = args.shift();
		if (!directory || args.length) throw new HostError("DIRECTORY_REQUIRED");
		const running = await startStandalone(directory);
		console.error(
			JSON.stringify({ status: "ready", epoch: running.host.epoch }),
		);
		let stopping = false;
		const stop = async () => {
			if (stopping) return;
			stopping = true;
			await running.close();
			process.exitCode = 0;
		};
		process.once("SIGINT", () => void stop());
		process.once("SIGTERM", () => void stop());
		return;
	}
	if (!profilePath) throw new HostError("PROFILE_REQUIRED");
	const profile = readProfile(profilePath);
	if (command === "mcp") {
		if (args.length) throw new HostError("INVALID_ARGUMENTS");
		serveMemoryMcp(profile);
		return;
	}
	let params: unknown = {};
	if (args.length) {
		if (args.length !== 2 || args[0] !== "--input")
			throw new HostError("INVALID_ARGUMENTS");
		const path = args[1]!;
		const text = await readBoundedText(
			path === "-" ? Bun.stdin.stream() : Bun.file(path).stream(),
			HOST_LIMITS.requestBytes,
			"REQUEST_TOO_LARGE",
		);
		params = JSON.parse(text);
	}
	const result =
		command === "recall" ||
		command === "recall-size" ||
		(command === "plan" &&
			typeof params === "object" &&
			params !== null &&
			"message" in params)
			? await natural(profile, command, params)
			: await request(profile, command ?? "", params);
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = exitCode(result);
}
if (import.meta.main)
	main(process.argv.slice(2)).catch((error) => {
		const result = failure(error);
		console.error(JSON.stringify(result));
		process.exitCode = exitCode(result);
	});
