import OpenAI from "openai";
import { AWS_SIGNING_SERVICE, createSignedFetch } from "./awsSigner";
import { createLlmClientCache, llmClientCacheKey } from "./clientCache";
import type { ResolvedTarget } from "./providers";
import { fetchProvider } from "./providerFetch";

const clients = createLlmClientCache<OpenAI>();

/** Paid work is never replayed by an SDK; explicit run-level fallback owns retries. */
export const OPENAI_MAX_HTTP_RETRIES = 0;

/** Clients follow credential rotation without retaining secrets in cache keys. */
export function getOpenAIClient(target: ResolvedTarget): OpenAI {
  const key = llmClientCacheKey(target.baseUrl, target.auth, target.apiKey);
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({
      baseURL: target.baseUrl,
      apiKey: target.auth === "sigv4" ? "sigv4" : target.apiKey,
      fetch: target.auth === "sigv4" ? createSignedFetch(AWS_SIGNING_SERVICE) : fetchProvider,
      maxRetries: OPENAI_MAX_HTTP_RETRIES,
    });
    clients.set(key, client);
  }
  return client;
}
