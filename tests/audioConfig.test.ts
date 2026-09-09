import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { createAudioConfigUseCases, type AudioConfigInput } from "@/application/audio/audioConfig";
vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { audioJobConfigRepository as configs } from "@/infrastructure/db/repositories/audioJobConfigRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const input: AudioConfigInput = { enabled: true, model: "openai/whisper-1", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" }, maxActive: 1, maxPerOccurrence: 1 };
const authorize = vi.fn(async () => {});
const api = createAudioConfigUseCases({ configs, authorize, validate: async () => {}, now: () => new Date("2026-09-09T00:00:00Z") });
beforeEach(() => { vi.clearAllMocks(); fake.rows.clear(); fake.seed([{ ...keys.project("audio"), entityType: "PROJECT" }]); });
describe("revisioned audio configuration", () => {
  it("allows one winner when concurrent edits use the same revision", async () => {
    expect((await api.save("audio", "owner@example.test", input, 0)).revision).toBe(1);
    const result = await Promise.allSettled([
      api.save("audio", "owner@example.test", { ...input, maxActive: 2 }, 1),
      api.save("audio", "owner@example.test", { ...input, maxActive: 3 }, 1),
    ]);
    expect(result.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect((await api.get("audio", "owner@example.test"))?.revision).toBe(2);
  });
  it("validates limits and retention before persisting configuration", async () => {
    await expect(api.save("audio", "owner@example.test", { ...input, maxActive: 101 }, 0)).rejects.toMatchObject({ status: 400 });
    await expect(api.save("audio", "owner@example.test", { ...input, retention: { ...input.retention, value: -1 } }, 0)).rejects.toMatchObject({ status: 400 });
    expect(await configs.get("audio")).toBeNull();
  });
  it("never creates configuration under a deleting project", async () => {
    fake.seed([{ ...keys.project("audio"), entityType: "PROJECT", deletingAt: "2026-09-09T00:00:00Z" }]);
    await expect(api.save("audio", "owner@example.test", input, 0)).rejects.toMatchObject({ status: 409 });
    expect(await configs.get("audio")).toBeNull();
  });
  it("authorizes reads and writes before accessing stored configuration", async () => {
    authorize.mockRejectedValueOnce(new Error("denied"));
    await expect(api.save("audio", "other@example.test", input, 0)).rejects.toThrow("denied");
    authorize.mockRejectedValueOnce(new Error("denied"));
    await expect(api.get("audio", "other@example.test")).rejects.toThrow("denied");
  });
});
