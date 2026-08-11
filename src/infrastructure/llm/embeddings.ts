/**
 * Embeddings over the same OpenAI-compatible channel the engine dispatches on.
 *
 * Reuses `getLlmChannelConfig()` rather than taking credentials of its own: the
 * deployment already answered "which endpoint, which key" once, and a second
 * answer is a second thing to rotate. The model is separate because it has to
 * be — an embedding model is not a chat model, and its dimension has to match
 * the index the vectors go into.
 *
 * Not routed through `resolveProviderTarget`: that resolver exists to send a
 * `provider/model` id to that provider's own endpoint, and an embedding model
 * here is one id on one channel. Adding a second provider means a second
 * adapter behind {@link EmbeddingPort}, not a branch in this one.
 */

import OpenAI from "openai";
import type { EmbeddingPort } from "@/domain/vector/types";
import { getLlmChannelConfig } from "@/lib/runtime-settings";
import { config } from "@/lib/config";

const clients = new Map<string, OpenAI>();

/** Keyed like the chat channel's, so a settings change gets a fresh client. */
function getClient(baseUrl: string, apiKey: string): OpenAI {
  const key = `${baseUrl}|${apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ baseURL: baseUrl, apiKey });
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
    const { baseUrl, apiKey } = await getLlmChannelConfig();
    const client = getClient(baseUrl, apiKey);
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH);
      const response = await client.embeddings.create({
        model: config.embeddingModel,
        input: batch as string[],
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
      for (const item of ordered) {
        vectors.push(item.embedding);
      }
    }
    return vectors;
  },
};
