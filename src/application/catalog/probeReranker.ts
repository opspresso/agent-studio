import type { RerankerPort } from "@/domain/vector/types";
import { CAPABILITY_RERANK_INSTRUCTION } from "./searchCatalog";

const PROBE_QUERY = "What is the latest AWS EKS version?";
const PROBE_DOCUMENTS = [
  "aws-knowledge: Search current AWS documentation and service information, including Amazon EKS versions.",
  "slack: Send and read messages in Slack channels.",
] as const;

/** Verify that a reranker can distinguish capability descriptions using the production instruction. */
export async function probeCapabilityReranker(
  reranker: RerankerPort,
  signal?: AbortSignal,
): Promise<void> {
  const result = await reranker.rerank(
    PROBE_QUERY,
    [...PROBE_DOCUMENTS],
    CAPABILITY_RERANK_INSTRUCTION,
    signal,
  );
  if (result.scores[0] === undefined || result.scores[1] === undefined) {
    throw new Error("Reranker probe returned incomplete scores");
  }
  if (result.scores[0] <= result.scores[1]) {
    throw new Error("Reranker probe did not rank the relevant capability first");
  }
}
