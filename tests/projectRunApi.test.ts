import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAgent, streamPredict } from "@/app/projects/lib/api";

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

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({ signal: controller.signal });
    }
  });

  it("sends playground documents on both Agent endpoints", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({}),
    );
    vi.stubGlobal("fetch", fetchMock);
    const document = { b64: "AQID", mimeType: "application/octet-stream", name: "report.docx" };

    await streamPredict("demo", "v1", { documents: [document] });
    await streamAgent("demo", "v1", [{ role: "user", content: "read it" }], undefined, [document]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      documents: [document],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      documents: [document],
    });
  });
});
