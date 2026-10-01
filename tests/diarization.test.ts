import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSpeakerTimeline } from "@/domain/audio/diarization";
import { createDiarizer } from "@/infrastructure/llm/diarization";

const timeline = { duration: 400, revision: "weights-v1", turns: [
  { start: 0, end: 1, speaker: "SPEAKER_00" }, { start: 300, end: 301, speaker: "SPEAKER_00" },
], warnings: [] };
const config = { baseUrl: "http://diarization.test", token: "synthetic-token", revision: timeline.revision };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("whole-recording speaker timelines", () => {
  it("preserves labels across long gaps and permits unattributed intervals", () => {
    expect(validateSpeakerTimeline(timeline)).toBe(timeline);
    expect(validateSpeakerTimeline({ ...timeline, turns: [] }).turns).toEqual([]);
  });
  it.each([
    { duration: 0 }, { duration: 21601 }, { revision: "" }, { warnings: [1] },
    { turns: [{ start: 0, end: 401, speaker: "A" }] },
    { turns: [{ start: 1, end: 1, speaker: "A" }] },
    { turns: [{ start: 0, end: 2, speaker: "A" }, { start: 1, end: 3, speaker: "B" }] },
    { turns: [{ start: 0, end: 1, speaker: "" }] },
  ])("rejects malformed or non-exclusive output: %j", patch => {
    expect(() => validateSpeakerTimeline({ ...timeline, ...patch } as typeof timeline)).toThrow("Speaker timeline is invalid");
  });
});

describe("private diarization adapter", () => {
  it("sends the entire source with authentication and refuses redirects", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    const fetch = vi.fn(async () => Response.json(timeline)); vi.stubGlobal("fetch", fetch);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await createDiarizer(config).analyze({ bytes, mimeType: "audio/mpeg" })).toEqual(timeline);
    expect(fetch).toHaveBeenCalledWith(new URL("http://diarization.test/diarize"), expect.objectContaining({
      method: "POST", redirect: "error", body: bytes,
      headers: { authorization: "Bearer synthetic-token", "content-type": "audio/mpeg" },
    }));
  });
  it.each([401, 503, 422])("surfaces service HTTP %i without exposing its body", async status => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private content", { status })));
    await expect(createDiarizer(config).analyze({ bytes: new Uint8Array([1]), mimeType: "audio/wav" }))
      .rejects.toThrow(`Diarization service returned HTTP ${status}`);
  });
  it("rejects changed model revisions and cancellation before uploading", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    const fetch = vi.fn(async () => Response.json({ ...timeline, revision: "different" })); vi.stubGlobal("fetch", fetch);
    const port = createDiarizer(config);
    await expect(port.analyze({ bytes: new Uint8Array([1]), mimeType: "audio/wav" })).rejects.toThrow("invalid timeline or revision");
    fetch.mockClear();
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(port.analyze({ bytes: new Uint8Array([1]), mimeType: "audio/wav" }, controller.signal)).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects embedded credentials and missing tokens", () => {
    expect(() => createDiarizer({ ...config, baseUrl: "http://user:password@diarization.test" })).toThrow("configuration is invalid");
    expect(() => createDiarizer({ ...config, token: "" })).toThrow("configuration is invalid");
  });
});
