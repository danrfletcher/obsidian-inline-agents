import type { HttpFn, HttpOutcome, HttpRequest } from "./types";

/** What the real transport (Obsidian's `requestUrl`) must provide: status and, only on request, the response text. */
export interface RawResponse {
	status: number;
	/** Read lazily — see `createHttpFn`: only touched when the request asked for its body. */
	readText: () => string;
}

export type Transport = (request: HttpRequest) => Promise<RawResponse>;

export interface HttpTimers {
	setTimer: (callback: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}

/**
 * The obsidian-free half of the HTTP adapter: applies the timeout, turns a
 * thrown transport error into a fixed outcome, and reads the response body
 * only when `request.readBody` is set. Split out of httpAdapter.ts (which
 * imports `requestUrl`, unavailable outside Obsidian) so the timeout and
 * body rules can be tested under Node with a fake transport and fake timers.
 *
 * This is also the one place a thrown error gets turned into a fixed,
 * non-echoing reason before anything downstream can turn it into a
 * user-facing message — F5 requires that no failure path ever surfaces a
 * raw error string (which could, depending on the underlying transport,
 * embed the request URL or other request detail).
 */
export function createHttpFn(transport: Transport, timeoutMs: number, timers: HttpTimers): HttpFn {
	return (request) => {
		return new Promise<HttpOutcome>((resolve) => {
			let settled = false;
			const timer = timers.setTimer(() => {
				if (settled) return;
				settled = true;
				resolve({ kind: "timeout" });
			}, timeoutMs);

			// Wrapped in an async function so a transport that throws
			// synchronously becomes a rejection, and still resolves (never
			// rejects) like every other failure mode.
			const pending = (async () => transport(request))();

			pending
				.then((response) => {
					if (settled) return;
					// G15: the chat kind never reads the response body, so
					// `readText` is only called when the request asked for it
					// (the hook kind parses its `{ ok, runId }` reply). Built
					// before `settled` is set: if reading throws, the catch
					// below still has to resolve the outcome.
					const outcome: HttpOutcome = request.readBody
						? { kind: "response", status: response.status, body: response.readText() }
						: { kind: "response", status: response.status };
					settled = true;
					timers.clearTimer(timer);
					resolve(outcome);
				})
				.catch((err: unknown) => {
					if (settled) return;
					settled = true;
					timers.clearTimer(timer);
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
