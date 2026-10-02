/**
 * Deployment-selected providers may be internal, but redirects cannot select
 * another recipient for private prompts, audio, documents or credentials.
 * Apply this after caller options so Requests and SDK overrides cannot replay
 * a provider request at a redirect destination.
 */
export function fetchProvider(
  input: string | URL | Request,
  init?: RequestInit,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  return fetchFn(input, { ...init, redirect: "error" });
}
