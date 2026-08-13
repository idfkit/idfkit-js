/**
 * Shared HTTP plumbing for the network edge.
 *
 * Everything that reaches the network takes an optional `fetch` so callers can
 * substitute their own — most importantly to route through a CORS proxy in the
 * browser, since climate.onebuilding.org serves no `Access-Control-Allow-Origin`
 * header. See the how-to guide for the proxy pattern.
 */

/** The subset of the `fetch` signature this package relies on. */
export type FetchLike = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<Response>;

/** Identifies the client to upstream services, as the Python library does. */
export const USER_AGENT = 'idfkit-js (https://github.com/idfkit/idfkit-js)';

/** Resolve the caller's `fetch`, or the global one, or fail with a clear message. */
export function resolveFetch(provided?: FetchLike): FetchLike {
  if (provided) return provided;
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (globalFetch) return globalFetch;
  throw new Error(
    'No global fetch is available in this runtime. Pass `fetch` explicitly in the options.'
  );
}
