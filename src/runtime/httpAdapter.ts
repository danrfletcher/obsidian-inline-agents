import { requestUrl } from "obsidian";
import type { HttpFn, HttpOutcome } from "./types";

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * The only place `requestUrl` is imported outside main.ts/settings glue —
 * every tested module takes an `HttpFn` instead (see types.ts), so the test
 * suite never needs a real or mocked Obsidian to run (`requestUrl` has no
 * runtime implementation outside Obsidian; the npm "obsidian" package ships
 * types only).
 *
 * Also the one place a thrown error gets turned into a fixed, non-echoing
 * reason before anything downstream can turn it into a user-facing message
 * — F5 requires that no failure path ever surfaces a raw error string
 * (which could, depending on the underlying transport, embed the request
 * URL or other request detail).
 */
export function createObsidianHttpFn(timeoutMs: number = DEFAULT_TIMEOUT_MS): HttpFn {
	return (request) => {
		return new Promise<HttpOutcome>((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve({ kind: "timeout" });
			}, timeoutMs);

			requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				throw: false,
			})
				.then((response) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({ kind: "response", status: response.status });
				})
				.catch((err: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					const message = err instanceof Error ? err.message : String(err);
					if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|refused/i.test(message)) {
						resolve({ kind: "refused" });
					} else {
						resolve({ kind: "error", reason: "request failed" });
					}
				});
		});
	};
}
