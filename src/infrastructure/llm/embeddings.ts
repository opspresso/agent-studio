/**
 * OpenAI-compatible embeddings for the selected registered retrieval model.
 * Runtime settings resolve its endpoint, credential and wire ID together;
 * there is no dedicated-endpoint or default-chat-channel fallback.
 */

import OpenAI from "openai";
import { createLlmClientCache, llmClientCacheKey } from "./clientCache";
import { OPENAI_MAX_HTTP_RETRIES } from "./openaiClient";
import type { EmbeddingPort } from "@/domain/vector/types";
import { getEmbeddingTarget, getEmbeddingModel } from "@/lib/runtime-settings";
import { config } from "@/lib/config";

const clients = createLlmClientCache<OpenAI>();

/** Keyed like the chat channel's, so a settings change gets a fresh client. */
function getClient(baseUrl: string, apiKey: string): OpenAI {
  const key = llmClientCacheKey(baseUrl, apiKey);
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ baseURL: baseUrl, apiKey, maxRetries: OPENAI_MAX_HTTP_RETRIES });
    clients.set(key, client);
  }
  return client;
}

/**
 * How many texts go in one request.
 *
 * A reindex embeds the whole catalog, and providers bound both the array length
 * and the request body. Chunking here rather than at the caller keeps every
 * caller from discovering that bound the hard way, on the day the catalog grows
 * past it.
 */
const BATCH = 96;

export const openAiEmbeddings: EmbeddingPort = {
  // OpenAI's embedding models use one space for both sides of a search, so the
  // purpose is not read here — see the port for why callers state it anyway.
  async embed(texts) {
    if (texts.length === 0) {
      return [];
    }
    const { baseUrl, apiKey, model } = await getEmbeddingTarget(await getEmbeddingModel());
    const client = getClient(baseUrl, apiKey);
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH);
      const response = await client.embeddings.create({
        model,
        input: batch as string[],
        // Explicit dimensions keep indexing and queries in the same vector
        // space. Native mode omits the parameter for models that reject it.
        ...(config.embeddingDimensions !== undefined
          ? { dimensions: config.embeddingDimensions }
          : {}),
        // Stated rather than left to the SDK, which defaults to base64 and
        // decodes the answer itself. That default is a bandwidth optimization
        // against OpenAI; here the base URL is as likely to be a router or a
        // provider's own compatible endpoint, and the ones that answer in plain
        // floats would have their response decoded as base64 into empty vectors
        // — valid-looking arrays that rank everything identically.
        encoding_format: "float",
      });
      // Sorted by the provider's own index rather than trusted to arrive in
      // order: the response contract is that each item carries its position,
      // and a caller matching vectors to entries by array position would pair
      // the wrong description with the wrong name if a provider ever answered
      // out of order — silently, and only in the ranking.
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== batch.length) {
        throw new Error(
          `Embedding response returned ${ordered.length} vectors for ${batch.length} inputs`,
        );
      }
      if (ordered.some((item, index) => item.index !== index)) {
        throw new Error("Embedding response indexes must cover each input exactly once");
      }
      for (const item of ordered) {
        vectors.push(item.embedding);
      }
    }
    return vectors;
  },
};
