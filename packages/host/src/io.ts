import { HostError } from "./contracts.ts";

/** Enforce the wire byte limit while reading, before allocating the entire body. */
export async function readBoundedText(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	code: string,
	status = "blocked",
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let finished = false;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				finished = true;
				break;
			}
			bytes += chunk.value.byteLength;
			if (bytes > limit) throw new HostError(code, status);
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		if (!finished) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
