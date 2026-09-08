import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { createAudioJobUseCases, type AudioJobUseCaseDeps, type SubmitAudioJobInput } from "@/application/audio/audioJobUseCases";
vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { audioJobRepository as jobs } from "@/infrastructure/db/repositories/audioJobRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
beforeEach(() => { fake.rows.clear(); fake.seed([{ ...keys.project("audio"), entityType: "PROJECT" }]); });
function fixture() {
  let id = 0;
  const deps: AudioJobUseCaseDeps = {
    jobs, files: { get: async () => null }, sourceIdentity: vi.fn(async () => ({ namespace: "external-account", itemId: "recording-1" })),
    authorize: vi.fn(async () => {}), validateModel: vi.fn(async () => {}), validateOutputs: vi.fn(async () => ({})),
    limits: async () => ({ maxActive: 2, maxPerOccurrence: 2 }), now: () => new Date("2026-09-09T00:00:00Z"), id: () => `job-${++id}`,
  };
  const input: SubmitAudioJobInput = { source: { kind: "source", sourceRef: "reference-1" }, model: "openai/whisper-1",
    retention: { unit: "months", value: 3, timezone: "Asia/Seoul" } };
  return { deps, input, api: createAudioJobUseCases(deps) };
}
describe("audio job use cases", () => {
  it("deduplicates refreshed references by stable external identity and hides internal input", async () => {
    const { api, input } = fixture();
    const first = await api.submit("audio", "owner@example.test", input, { occurrence: "hour-1" });
    const second = await api.submit("audio", "owner@example.test", { ...input, source: { kind: "source", sourceRef: "refreshed" } }, { occurrence: "hour-2" });
    expect(first.status).toBe("accepted"); expect(second.status).toBe("duplicate");
    expect("job" in first && first.job).not.toHaveProperty("sourceKey");
    expect("job" in first && first.job).not.toHaveProperty("userEmail");
    expect("job" in first && first.job).not.toHaveProperty("source");
  });
  it("does not require an ASR model for import-only tasks", async () => {
    const { api, deps, input } = fixture();
    expect((await api.submit("audio", "owner@example.test", { ...input, model: undefined, task: "import" }, { occurrence: "one" })).status).toBe("accepted");
    expect(deps.validateModel).not.toHaveBeenCalled();
  });
  it("filters other users before applying the list limit", async () => {
    const { api, input } = fixture();
    await api.submit("audio", "other@example.test", input, { occurrence: "one" });
    await api.submit("audio", "owner@example.test", input, { occurrence: "two" });
    expect((await api.list("audio", "owner@example.test", 1)).map((job) => job.id)).toEqual(["job-2"]);
    await expect(api.get("audio", "job-1", "owner@example.test")).rejects.toMatchObject({ status: 404 });
    await expect(api.cancel("audio", "job-1", "owner@example.test", 1)).rejects.toMatchObject({ status: 404 });
  });
  it("requires an explicit processing revision for a new run of the same source", async () => {
    const { api, input } = fixture();
    await api.submit("audio", "owner@example.test", input, { occurrence: "one" });
    expect((await api.submit("audio", "owner@example.test", { ...input, processingRevision: "2" }, { occurrence: "two" })).status).toBe("accepted");
  });
  it("rejects invalid output options before admission", async () => {
    const { api, input } = fixture();
    await expect(api.submit("audio", "owner@example.test", { ...input, task: "transcribe",
      destination: { serverName: "memory", documents: true, memories: true } }, { occurrence: "one" }))
      .rejects.toMatchObject({ status: 400 });
    expect(await jobs.list("audio", 10)).toEqual([]);
  });
});
