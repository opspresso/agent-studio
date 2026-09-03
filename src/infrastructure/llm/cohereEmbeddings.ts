/**
 * {@link EmbeddingPort} over Cohere Embed v4 on Bedrock.
 *
 * The multilingual one, and the reason this deployment has it: a Korean query
 * against an English description scores 0.39 here against 0.07 on Titan v2,
 * where an unrelated pair scores 0.04 — Titan cannot tell "깃헙 레포 알려줘"
 * from noise, so a registry described in English is unreachable from a Korean
 * request. Cohere separates them by a factor of two.
 *
 * What it costs is that everything scores higher, unrelated pairs included, so
 * the relevance floor sits proportionally higher too — see `DEFAULT_MIN_SCORE`.
 *
 * **`input_type` is the whole point.** Cohere embeds a question and the thing
 * that answers it into different spaces, and passing the same type for both
 * throws away most of what makes it better here. That is why the port carries
 * a purpose at all.
 *
 * Reached through its **inference profile** (`global.cohere.embed-v4:0`): the
 * bare model id refuses on-demand invocation outright.
 */

import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingPort, EmbeddingPurpose } from "@/domain/vector/types";
import { bedrockRuntime } from "./bedrockClient";
import { config } from "@/lib/config";
import { getEmbeddingModel } from "@/lib/runtime-settings";
import { wireModelId } from "@/domain/llm/models";

/** Cohere's own names for the two sides of a search. */
const INPUT_TYPE: Record<EmbeddingPurpose, string> = {
  document: "search_document",
  query: "search_query",
};

/**
 * Texts per request. Cohere takes an array, unlike Titan — so a reindex is a
 * handful of calls rather than one per entry — and this is well inside the
 * provider's own cap.
 */
const BATCH = 96;

export const cohereEmbeddings: EmbeddingPort = {
  async embed(texts, purpose) {
    if (texts.length === 0) {
      return [];
    }
    const model = wireModelId(await getEmbeddingModel());
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH);
      const response = await bedrockRuntime().send(
        new InvokeModelCommand({
          modelId: model,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            texts: batch,
            input_type: INPUT_TYPE[purpose],
            embedding_types: ["float"],
            // The index was created for exactly one width; v4 serves several.
            ...(config.embeddingDimensions !== undefined
              ? { output_dimension: config.embeddingDimensions }
              : {}),
          }),
        }),
      );
      const decoded: unknown = JSON.parse(new TextDecoder().decode(response.body));
      const embeddings =
        typeof decoded === "object" && decoded !== null
          ? (decoded as { embeddings?: { float?: number[][] } | number[][] }).embeddings
          : undefined;
      // v4 answers `{embeddings: {float: [...]}}`; older shapes answer a bare
      // array. Both are read rather than assumed, since the model id is config.
      const batchVectors = Array.isArray(embeddings) ? embeddings : embeddings?.float;
      if (!batchVectors || batchVectors.length !== batch.length) {
        throw new Error(
          `Cohere model ${model} returned ${batchVectors?.length ?? 0} vectors for ${batch.length} inputs`,
        );
      }
      vectors.push(...batchVectors);
    }
    return vectors;
  },
};
