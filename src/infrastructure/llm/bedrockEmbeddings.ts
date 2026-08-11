/**
 * {@link EmbeddingPort} over Bedrock, which is what `mcp-memory` already
 * embeds with on this deployment.
 *
 * Matching it is not a preference: both write into the same S3 Vectors bucket,
 * and an index's dimension is fixed at creation. Two models would mean two
 * indexes that cannot be compared, and — worse — a run that embedded a query
 * with one and queried an index built by the other would get scores that are
 * *plausible and wrong*, with nothing raising an error.
 *
 * The pod needs no credentials of its own: an EKS Pod Identity association
 * binds the service account to a role carrying `bedrock:InvokeModel`, the same
 * way the DynamoDB and S3 clients here are already authorized.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingPort } from "@/domain/vector/types";
import { config } from "@/lib/config";

let client: BedrockRuntimeClient | undefined;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({ region: config.awsRegion });
  }
  return client;
}

/**
 * Titan embeds **one text per request** — there is no batch form — so a reindex
 * of the whole registry is that many calls. They go out in waves rather than
 * all at once: Bedrock throttles per account, and a burst of several hundred
 * would fail most of them, turning a slow reindex into a failed one.
 */
const CONCURRENCY = 8;

async function embedOne(text: string): Promise<number[]> {
  const response = await getClient().send(
    new InvokeModelCommand({
      modelId: config.embeddingModel,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        // Titan v2 serves several dimensions from one model, and the index was
        // created for exactly one of them. Asking for it explicitly is what
        // keeps a default change from producing vectors the index rejects.
        dimensions: config.embeddingDimensions,
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
    throw new Error(`Bedrock model ${config.embeddingModel} returned no embedding`);
  }
  return embedding as number[];
}

export const bedrockEmbeddings: EmbeddingPort = {
  async embed(texts) {
    const vectors: number[][] = new Array<number[]>(texts.length);
    for (let start = 0; start < texts.length; start += CONCURRENCY) {
      const wave = texts.slice(start, start + CONCURRENCY);
      const embedded = await Promise.all(wave.map((text) => embedOne(text)));
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
