/**
 * {@link EmbeddingPort} over Bedrock for the capability catalog.
 *
 * The model that writes the pgvector rows must also embed every query. Vectors
 * from two models are not comparable and can produce plausible but wrong
 * scores without raising an error; the reindex generation keeps both sides on
 * one configured model.
 *
 * The pod needs no credentials of its own: an EKS Pod Identity association
 * binds the service account to a role carrying `bedrock:InvokeModel`, the same
 * way the artifact S3 client is authorized.
 */

import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingPort } from "@/domain/vector/types";
import { bedrockRuntime } from "./bedrockClient";
import { config } from "@/lib/config";
import { getEmbeddingModel } from "@/lib/runtime-settings";
import { wireModelId } from "@/domain/llm/models";

/**
 * Titan embeds **one text per request** — there is no batch form — so a reindex
 * of the whole registry is that many calls. They go out in waves rather than
 * all at once: Bedrock throttles per account, and a burst of several hundred
 * would fail most of them, turning a slow reindex into a failed one.
 */
const CONCURRENCY = 8;

async function embedOne(text: string, model: string): Promise<number[]> {
  const response = await bedrockRuntime().send(
    new InvokeModelCommand({
      modelId: model,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        // Titan v2 serves several dimensions from one model, and the index was
        // created for exactly one of them. Asking for it explicitly is what
        // keeps a default change from producing vectors the index rejects.
        ...(config.embeddingDimensions !== undefined
          ? { dimensions: config.embeddingDimensions }
          : {}),
        // Unit-length vectors, so cosine distance is the metric the index was
        // built with rather than something proportional to it.
        normalize: true,
      }),
    }),
  );
  const decoded: unknown = JSON.parse(new TextDecoder().decode(response.body));
  const embedding =
    typeof decoded === "object" && decoded !== null
      ? (decoded as { embedding?: unknown }).embedding
      : undefined;
  if (!Array.isArray(embedding)) {
    throw new Error(`Bedrock model ${model} returned no embedding`);
  }
  return embedding as number[];
}

export const bedrockEmbeddings: EmbeddingPort = {
  // Titan embeds both sides of a search into one space, so the purpose is not
  // read here. Stating it is still the caller's job — which model cares is the
  // adapter's business, not theirs.
  async embed(texts) {
    const model = wireModelId(await getEmbeddingModel());
    const vectors: number[][] = new Array<number[]>(texts.length);
    for (let start = 0; start < texts.length; start += CONCURRENCY) {
      const wave = texts.slice(start, start + CONCURRENCY);
      const embedded = await Promise.all(wave.map((text) => embedOne(text, model)));
      // Written back by absolute position rather than pushed: `Promise.all`
      // preserves order within a wave, and the offset is what keeps the waves
      // in order too — a vector paired with the wrong entry is the failure this
      // whole file is arranged to avoid.
      for (const [offset, vector] of embedded.entries()) {
        vectors[start + offset] = vector;
      }
    }
    return vectors;
  },
};
