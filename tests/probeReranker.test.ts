import { describe, expect, it, vi } from "vitest";
import { probeCapabilityReranker } from "@/application/catalog/probeReranker";
import { CAPABILITY_RERANK_INSTRUCTION } from "@/application/catalog/searchCatalog";

describe("probeCapabilityReranker", () => {
  it("uses the production capability instruction and accepts semantic ordering", async () => {
    const signal = new AbortController().signal;
    const rerank = vi.fn(async () => ({ scores: [0.8, 0.1] }));

    await probeCapabilityReranker({ rerank }, signal);

    expect(rerank).toHaveBeenCalledWith(
      "What is the latest AWS EKS version?",
      [
        expect.stringContaining("aws-knowledge"),
        expect.stringContaining("slack"),
      ],
      CAPABILITY_RERANK_INSTRUCTION,
      signal,
    );
  });

  it("rejects a reachable endpoint that cannot rank the relevant capability first", async () => {
    const rerank = vi.fn(async () => ({ scores: [0.1, 0.8] }));

    await expect(probeCapabilityReranker({ rerank })).rejects.toThrow(
      "did not rank the relevant capability first",
    );
  });
});
