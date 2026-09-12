import OpenAI from "openai";
import { AWS_SIGNING_SERVICE, createSignedFetch } from "./awsSigner";
import { createLlmClientCache, llmClientCacheKey } from "./clientCache";
import type { ResolvedTarget } from "./providers";

const clients = createLlmClientCache<OpenAI>();

/** Clients follow credential rotation without retaining secrets in cache keys. */
export function getOpenAIClient(target: ResolvedTarget, maxRetries = 2): OpenAI {
  const key = llmClientCacheKey(target.baseUrl, target.auth, target.apiKey, String(maxRetries));
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({
      baseURL: target.baseUrl,
      apiKey: target.auth === "sigv4" ? "sigv4" : target.apiKey,
      ...(target.auth === "sigv4" ? { fetch: createSignedFetch(AWS_SIGNING_SERVICE) } : {}),
      maxRetries,
    });
    clients.set(key, client);
  }
  return client;
}
