import { describe, expect, it } from "vitest";
import { sseResponse } from "@/lib/sse";

describe("sseResponse cancellation", () => {
  it("aborts in-flight work and closes the source generator", async () => {
    const abortController = new AbortController();
    let finalized = false;
    async function* source(): AsyncGenerator<unknown> {
      try {
        yield { delta: "first" };
        await new Promise<void>((_resolve, reject) => {
          abortController.signal.addEventListener(
            "abort",
            () => reject(abortController.signal.reason),
            { once: true },
          );
        });
      } finally {
        finalized = true;
      }
    }

    const response = sseResponse(source(), abortController);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel("client disconnected");

    expect(abortController.signal.aborted).toBe(true);
    expect(finalized).toBe(true);
  });
});
