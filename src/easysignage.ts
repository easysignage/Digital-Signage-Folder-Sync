// The EasySignage SDK client, plus a wrapper that records every call for the log panel.
import { AsyncLocalStorage } from "node:async_hooks";
import { APIError, EasySignage } from "@easysignage/sdk";
import { config } from "./config.ts";
import { log } from "./log.ts";

interface Trace {
  requests: string[];
  /** `error_msg` codes the API returned, including on successful responses. */
  codes: string[];
}

const trace = new AsyncLocalStorage<Trace>();

// A fetch that notes each HTTP request made inside `call()`, so the log can show the real route
// behind every SDK method. Only the path is kept; query strings (e.g. signed upload URLs) are not.
const tracingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const t = trace.getStore();
  if (t) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    t.requests.push(`${method} ${url.pathname} → ${res.status}`);
    if (res.headers.get("content-type")?.includes("json")) {
      const body = await res.clone().json().catch(() => undefined);
      if (body && typeof body.error_msg === "string" && body.error_msg) t.codes.push(body.error_msg);
    }
  }
  return res;
};

export const client = new EasySignage({ apiKey: config.apiKey, baseURL: config.baseURL, fetch: tracingFetch });

export interface CallOutcome<T> {
  result: T;
  /** The API's `error_msg` code when it answered success with one (e.g. `publish_no_players`). */
  code?: string;
}

/**
 * Runs one SDK call and logs it: the method, the HTTP route(s), the response and the time taken.
 * Failures are logged and rethrown; `APIError.code` carries the API's machine-readable reason.
 */
export async function call<T>(label: string, fn: () => Promise<T>): Promise<CallOutcome<T>> {
  const t: Trace = { requests: [], codes: [] };
  const started = Date.now();
  try {
    const result = await trace.run(t, fn);
    const code = t.codes.at(-1);
    log(code ? "warn" : "api", code ?? "", { call: label, requests: t.requests, result, durationMs: Date.now() - started });
    return { result, code };
  } catch (err) {
    const message = err instanceof APIError ? `${err.status} ${err.code ?? ""}`.trim() : String(err);
    log("error", message, { call: label, requests: t.requests, durationMs: Date.now() - started });
    throw err;
  }
}

/** The API's machine-readable code for a failed or partly-failed call. */
export function codeOf(err: unknown): string | undefined {
  return err instanceof APIError ? err.code : undefined;
}

/** Every media item in a playlist, in play order. */
export function playlistMedia(playlistId: string) {
  return client.media.iterate({ playlist: playlistId });
}
