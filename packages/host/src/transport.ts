import {
	chmodSync,
	readFileSync,
	unlinkSync,
	existsSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import {
	configSchema,
	demand,
	failure,
	HOST_LIMITS,
	HostError,
	profileSchema,
	type HostResult,
	type Profile,
} from "./contracts.ts";
import { readBoundedText } from "./io.ts";
import { MemoryHost } from "./service.ts";
import { openStandalone } from "./storage.ts";

export function readProfile(path: string): Profile {
	return profileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export async function request(
	profile: Profile,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<HostResult> {
	const body = JSON.stringify({ version: 1, method, params });
	demand(
		Buffer.byteLength(body) <= HOST_LIMITS.requestBytes,
		"REQUEST_TOO_LARGE",
	);
	try {
		const response = await fetch("http://localhost/memory", {
			unix: profile.socketPath,
			method: "POST",
			body,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${profile.credential}`,
			},
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(HOST_LIMITS.timeoutMs)])
				: AbortSignal.timeout(HOST_LIMITS.timeoutMs),
		});
		demand(response.ok, "CONNECTION_REJECTED");
		demand(response.body, "INVALID_RESPONSE");
		const text = await readBoundedText(
			response.body,
			HOST_LIMITS.responseBytes,
			"RESPONSE_TOO_LARGE",
		);
		return JSON.parse(text) as HostResult;
	} catch (error) {
		if (error instanceof HostError) return failure(error);
		return { status: "failed", code: "CONNECTION_FAILED" };
	}
}
export async function serveHost(
	host: MemoryHost,
	socketPath: string,
	credentials: () => string[] = () => Object.keys(host.config.credentials),
) {
	demand(Buffer.byteLength(socketPath) < 104, "SOCKET_PATH_TOO_LONG");
	let active = 0;
	const server = Bun.serve({
		unix: socketPath,
		maxRequestBodySize: HOST_LIMITS.requestBytes,
		async fetch(req) {
			if (req.method !== "POST" || new URL(req.url).pathname !== "/memory")
				return new Response(null, { status: 404 });
			let admitted = false;
			try {
				const bearer = req.headers.get("authorization");
				if (!bearer?.startsWith("Bearer "))
					return Response.json({ status: "blocked", code: "AUTH_REQUIRED" });
				const credential = bearer.slice(7);
				if (!credentials().includes(credential))
					return Response.json({ status: "blocked", code: "AUTH_REQUIRED" });
				if (active >= HOST_LIMITS.requests)
					return Response.json({ status: "blocked", code: "HOST_BUSY" });
				active++;
				admitted = true;
				const text = await req.text();
				demand(
					Buffer.byteLength(text) <= HOST_LIMITS.requestBytes,
					"REQUEST_TOO_LARGE",
				);
				const body = JSON.parse(text) as Record<string, unknown>;
				demand(
					body &&
						body["version"] === 1 &&
						typeof body["method"] === "string" &&
						Object.keys(body).sort().join() === "method,params,version",
					"INVALID_REQUEST",
				);
				const result = await host.dispatch(
					credential,
					body["method"],
					body["params"],
				);
				const encoded = JSON.stringify(result);
				return Buffer.byteLength(encoded) <= HOST_LIMITS.responseBytes
					? new Response(encoded, {
							headers: { "content-type": "application/json" },
						})
					: Response.json({ status: "blocked", code: "RESPONSE_TOO_LARGE" });
			} catch (error) {
				return Response.json(failure(error));
			} finally {
				if (admitted) active--;
			}
		},
	});
	chmodSync(socketPath, 0o600);
	return {
		server,
		close: async () => {
			await server.stop(true);
		},
	};
}
export async function startStandalone(directory: string) {
	const configuration = () =>
		configSchema.parse(
			JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")),
		);
	const owner = openStandalone(directory);
	try {
		const host = new MemoryHost({ port: owner.port, configuration });
		await host.start();
		const path = configuration().socketPath;
		demand(
			path === join(realpathSync(directory), "memory.sock"),
			"SOCKET_STORE_MISMATCH",
		);
		// Ownership lock was acquired before removing a stale socket.
		if (existsSync(path)) unlinkSync(path);
		const transport = await serveHost(host, path);
		return {
			host,
			close: async () => {
				await transport.close();
				await owner.close();
			},
		};
	} catch (error) {
		await owner.close();
		throw error;
	}
}
