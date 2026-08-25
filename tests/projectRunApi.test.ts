import { afterEach, describe, expect, it, vi } from "vitest";
import { predictImage, streamAgent, streamPredict } from "@/app/projects/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project run API", () => {
  it("forwards cancellation to every playground execution request", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ imageBase64: "AAAA", mimeType: "image/png", usage: { costUsd: 0 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await streamPredict("demo", "v1", {}, controller.signal);
    await streamAgent("demo", "v1", [], controller.signal);
    await predictImage("demo", "v1", { prompt: "draw" }, controller.signal);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ signal: controller.signal });
    }
  });
});
