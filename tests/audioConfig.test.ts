import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { createAudioConfigUseCases, type AudioConfigInput } from "@/application/audio/audioConfig";
vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { audioJobConfigRepository as configs } from "@/infrastructure/db/repositories/audioJobConfigRepository";
import { versionRepository as versions } from "@/infrastructure/db/repositories/versionRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const input: AudioConfigInput = { enabled: true, model: "openai/whisper-1", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" }, maxActive: 1, maxPerOccurrence: 1 };
const authorize = vi.fn(async () => {});
const api = createAudioConfigUseCases({ configs, authorize, validate: async () => {}, now: () => new Date("2026-09-09T00:00:00Z") });
beforeEach(() => { vi.clearAllMocks(); fake.rows.clear(); fake.seed([{ ...keys.project("audio"), entityType: "PROJECT" }]); });
describe("revisioned audio configuration", () => {
  const updatedAt = "2026-09-08T00:00:00.000Z";
  const seedWriter = () => fake.seed([
    { ...keys.project("writer"), entityType: "PROJECT", ownerEmail: "owner@example.test", updatedAt },
    { ...keys.version("writer", "1"), entityType: "VERSION", projectName: "writer", versionName: "1" },
  ]);
  const fixedWriter = { ...input, postprocess: { projectName: "writer", versionName: "1" } };

  it("fences a version deletion that checked references before this save", async () => {
    seedWriter();
    const before = await store.getItem(keys.project("writer"));
    await api.save("audio", "owner@example.test", fixedWriter, 0);
    expect(await store.getItem(keys.project("writer"))).toEqual({ ...before, updatedAt: expect.any(String) });
    await expect(versions.delete("writer", "1", updatedAt)).rejects.toThrow();
    expect(await store.getItem(keys.version("writer", "1"))).not.toBeNull();
  });

  it("refuses a reference saved after its version was deleted", async () => {
    seedWriter();
    await versions.delete("writer", "1", updatedAt);
    await expect(api.save("audio", "owner@example.test", fixedWriter, 0)).rejects.toMatchObject({ status: 409 });
    expect(await configs.get("audio")).toBeNull();
  });

  it("rolls back the reference fence if the configuration revision loses", async () => {
    seedWriter();
    await api.save("audio", "owner@example.test", fixedWriter, 0);
    const before = await store.getItem(keys.project("writer"));
    await expect(api.save("audio", "owner@example.test", fixedWriter, 0)).rejects.toMatchObject({ status: 409 });
    expect(await store.getItem(keys.project("writer"))).toEqual(before);
  });

  it("checks published aliases and advances a same-timestamp fence", async () => {
    seedWriter();
    const sameTime = "2026-09-09T00:00:00.000Z";
    fake.seed([{ ...keys.project("writer"), entityType: "PROJECT", ownerEmail: "owner@example.test", publishedVersion: "1", updatedAt: sameTime }]);
    const dynamic = { ...input, postprocess: { projectName: "writer", versionName: "published" } };
    await api.save("audio", "owner@example.test", dynamic, 0);
    expect((await store.getItem(keys.project("writer")))?.updatedAt).toBe("2026-09-09T00:00:00.001Z");
    expect((await configs.get("audio"))?.postprocess?.versionName).toBe("published");
  });
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
