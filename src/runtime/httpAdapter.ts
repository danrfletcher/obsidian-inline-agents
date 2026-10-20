import { requestUrl } from "obsidian";
import type { HttpFn } from "./types";
import { createHttpFn } from "./httpCore";

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * The only place `requestUrl` is imported outside main.ts/settings glue —
 * every tested module takes an `HttpFn` instead (see types.ts), so the test
 * suite never needs a real or mocked Obsidian to run (`requestUrl` has no
 * runtime implementation outside Obsidian; the npm "obsidian" package ships
 * types only). The timeout, error-normalising and body-reading rules live in
 * httpCore.ts, which is what the tests exercise.
 */
export function createObsidianHttpFn(timeoutMs: number = DEFAULT_TIMEOUT_MS): HttpFn {
	return createHttpFn(
		async (request) => {
			const response = await requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				body: request.body,
				throw: false,
			});
			// `.text` is a getter on the response (see RequestUrlResponse in
			// obsidian.d.ts), so wrapping it in a function keeps it unread
			// unless httpCore asks for it.
			return { status: response.status, readText: () => response.text };
		},
		timeoutMs,
		{
			setTimer: (callback, ms) => window.setTimeout(callback, ms),
			clearTimer: (handle) => window.clearTimeout(handle as number),
		}
	);
}
