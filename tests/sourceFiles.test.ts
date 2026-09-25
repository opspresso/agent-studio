import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { createSourceFileUseCases } from "@/application/artifact/sourceFiles";
import type { SourceObjectStore } from "@/domain/artifact/sourceObjectStore";
import { ValidationError } from "@/application/errors";
import { createAudioCleanup } from "@/application/audio/cleanup";
import type { AudioJob } from "@/domain/audio/job";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { sourceFileRepository as files } from "@/infrastructure/db/repositories/sourceFileRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
let clock: Date;
let contents: Map<string, { bytes: Uint8Array; mimeType: string; storedAt: string }>;
let objects: SourceObjectStore;
const input = { id: "file-1", agentName: "audio", userEmail: "owner@example.test", filename: "audio.mp3",
  mimeType: "audio/mpeg", retention: { unit: "months" as const, value: 3, timezone: "Asia/Seoul" } };
const open = vi.fn(async function* () { yield new Uint8Array([1, 2, 3]); });
const useCases = () => createSourceFileUseCases({ files, objects, now: () => clock });
beforeEach(() => {
  vi.clearAllMocks(); fake.rows.clear(); fake.seed([
    { ...keys.agent("audio"), entityType: "AGENT" }, { ...keys.agent("other"), entityType: "AGENT" },
  ]);
  clock = new Date("2026-11-30T01:00:00.000Z"); contents = new Map();
  objects = {
    write: vi.fn(async ({ key, body, mimeType }) => {
      const chunks: Uint8Array[] = [];
      for await (const part of body) chunks.push(part);
      const bytes = Buffer.concat(chunks);
      contents.set(key, { bytes, mimeType, storedAt: clock.toISOString() });
      return { byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") };
    }),
    stat: vi.fn(async (key) => {
      const item = contents.get(key);
      return item ? { byteSize: item.bytes.length, mimeType: item.mimeType, storedAt: item.storedAt } : null;
    }),
    read: vi.fn(async (key) => { const item = contents.get(key); if (!item) throw new Error("missing"); return item; }),
    delete: vi.fn(async (key) => { contents.delete(key); }),
  };
});
const openBody = async () => open();

describe("private source file lifecycle", () => {
  it("stores and publishes a provider title with the audio extension", async () => {
    const publish = vi.fn(async () => {});
    const api = createSourceFileUseCases({ files, objects, now: () => clock, publish });
    const file = await api.import({ ...input, filename: "주간 회의" }, openBody);
    expect(file.filename).toBe("주간 회의.mp3");
    expect((await files.get("audio", input.id))?.filename).toBe("주간 회의.mp3");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ filename: "주간 회의.mp3" }));
  });

  it("validates shared storage before opening a source or creating inventory", async () => {
    const api = createSourceFileUseCases({ files, objects, now: () => clock,
      assertWritable: async () => { throw new ValidationError("Private storage required"); } });
    await expect(api.import(input, openBody)).rejects.toMatchObject({ status: 400 });
    expect(open).not.toHaveBeenCalled();
    expect(await files.get(input.agentName, input.id)).toBeNull();
  });
  it("passes worker cancellation through reads and import metadata lookups", async () => {
    const controller = new AbortController();
    const api = useCases();
    await api.import(input, openBody, controller.signal);
    expect(objects.stat).toHaveBeenCalledWith("source-files/file-1", controller.signal);
    await api.read(input.agentName, input.id, input.userEmail, 10, controller.signal);
    expect(objects.read).toHaveBeenCalledWith("source-files/file-1", 10, controller.signal);
    controller.abort(new Error("shutdown"));
    await expect(api.sweep(100, controller.signal)).rejects.toThrow("shutdown");
  });
  it("does not return bytes when the file is deleted during the read", async () => {
    const api = useCases();
    await api.import(input, openBody);
    const read = objects.read;
    objects.read = vi.fn(async (key, limit) => {
      const bytes = await read(key, limit);
      await api.remove(input.agentName, input.id, input.userEmail);
      return bytes;
    });
    await expect(api.read(input.agentName, input.id, input.userEmail)).rejects.toMatchObject({ status: 409 });
  });
  it("retries artifact publication without downloading the completed file again", async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error("inventory unavailable")).mockResolvedValue(undefined);
    const api = createSourceFileUseCases({ files, objects, now: () => clock, publish });
    await expect(api.import(input, openBody)).rejects.toThrow("inventory unavailable");
    const file = await api.import(input, openBody);
    expect(file.status).toBe("ready");
    expect(open).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it("does not restore a retired pending upload's retention during recovery", async () => {
    const finish = vi.spyOn(files, "finish").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(useCases().import(input, openBody)).rejects.toThrow();
    const pending = (await files.get("audio", input.id))!;
    await files.retire(pending, clock.toISOString());
    expect(await useCases().sweep()).toEqual({ deleted: 1, failed: 0 });
    expect(contents.size).toBe(0);
    finish.mockRestore();
  });
  it("cleans checkpoints while retaining original and final artifacts after external delivery", async () => {
    fake.seed([{ ...keys.audioJob("audio", "job"), job: { status: "running", stage: "transcribing", userEmail: input.userEmail } }]);
    const api = useCases();
    const original = await api.import(input, openBody);
    for (const kind of ["checkpoint", "transcript", "draft"] as const) {
      await api.import({ ...input, id: kind, derived: { jobId: "job", kind } }, openBody);
    }
    fake.seed([{ ...keys.audioJob("audio", "job"), job: { status: "running", stage: "cleaning", userEmail: input.userEmail } }]);
    const job = { id: "job", agentName: "audio", userEmail: input.userEmail, fileId: input.id } as AudioJob;
    const context = { signal: new AbortController().signal, record: async () => {} };
    const clean = createAudioCleanup({ files, objects, now: () => clock });
    await clean(job, context);
    expect((await files.get("audio", "checkpoint"))?.status).toBe("deleted");
    expect((await files.get("audio", "transcript"))?.status).toBe("ready");
    const moved = { ...job, movedTo: { serverName: "memory", transcriptId: "doc-1", resultId: "doc-2" } };
    await clean(moved, context); await clean(moved, context);
    expect(contents.size).toBe(3);
    expect(await files.get("audio", input.id)).toEqual(original);
    expect(objects.delete).toHaveBeenCalledTimes(1);
    await expect(api.import({ ...input, id: "late", derived: { jobId: "job", kind: "checkpoint" } }, openBody)).rejects.toThrow();
    expect(await files.get("audio", "late")).toBeNull();
  });

  it("keeps deletion inventory when cleanup is interrupted and resumes without touching another job", async () => {
    for (const id of ["job", "other-job"]) fake.seed([{ ...keys.audioJob("audio", id), job: { status: "running", stage: "transcribing", userEmail: input.userEmail } }]);
    await useCases().import({ ...input, derived: { jobId: "job", kind: "checkpoint" } }, openBody);
    await useCases().import({ ...input, id: "other", derived: { jobId: "other-job", kind: "checkpoint" } }, openBody);
    const clean = createAudioCleanup({ files, objects, now: () => clock });
    const job = { id: "job", agentName: "audio", userEmail: input.userEmail } as AudioJob;
    const context = { signal: new AbortController().signal, record: async () => {} };
    vi.mocked(objects.delete).mockRejectedValueOnce(new Error("storage offline"));
    await expect(clean(job, context)).rejects.toThrow("storage offline");
    expect((await files.get("audio", input.id))?.status).toBe("deleting");
    await clean(job, context);
    expect((await files.get("audio", input.id))?.status).toBe("deleted");
    expect((await files.get("audio", "other"))?.status).toBe("ready");
  });

  it("bounds derived files by their original expiry even when replay requests a later deadline", async () => {
    const retainUntil = "2026-12-01T01:00:00.000Z";
    const file = await useCases().import({ ...input, retainUntil }, openBody);
    expect(file.retireAt).toBe(retainUntil);
    expect((await useCases().import({ ...input, retainUntil: "2027-04-01T00:00:00.000Z" }, openBody)).retireAt).toBe(retainUntil);
    clock = new Date(retainUntil);
    await expect(useCases().read(input.agentName, input.id, input.userEmail)).rejects.toMatchObject({ status: 409 });
    expect(await useCases().sweep()).toEqual({ deleted: 1, failed: 0 });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not extend the inherited deadline while recovering a completed upload", async () => {
    const retainUntil = "2026-11-30T02:00:00.000Z";
    const finish = vi.spyOn(files, "finish").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(useCases().import({ ...input, retainUntil }, openBody)).rejects.toThrow("database unavailable");
    clock = new Date(retainUntil);
    expect(await useCases().sweep()).toEqual({ deleted: 1, failed: 0 });
    expect(await files.get(input.agentName, input.id)).toMatchObject({ status: "deleted", retireAt: retainUntil });
    finish.mockRestore();
  });

  it("refuses expired or malformed deadlines before opening a provider", async () => {
    for (const retainUntil of [clock.toISOString(), "invalid", "2027-01-01"]) {
      await expect(useCases().import({ ...input, retainUntil }, openBody)).rejects.toThrow();
    }
    expect(open).not.toHaveBeenCalled();
    expect(await files.get(input.agentName, input.id)).toBeNull();
  });

  it("does not return readable output if its inherited deadline passes during upload", async () => {
    const retainUntil = "2026-11-30T02:00:00.000Z";
    await expect(useCases().import({ ...input, retainUntil }, async () => {
      clock = new Date(retainUntil);
      return open();
    })).rejects.toMatchObject({ status: 409 });
    expect(await useCases().sweep()).toEqual({ deleted: 1, failed: 0 });
  });

  it("closes the opened download when storage refuses it before reading", async () => {
    const close = vi.fn(async () => {});
    vi.mocked(objects.write).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(useCases().import(input, async () => Object.assign(open(), { close }))).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("does not open an upload for an agent being deleted", async () => {
    fake.seed([{ ...keys.agent("audio"), entityType: "AGENT", deletingAt: clock.toISOString() }]);
    await expect(useCases().import(input, openBody)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
  it("stores inventory and reuses the original completion date on replay", async () => {
    const api = useCases();
    const file = await api.import(input, openBody);
    expect(file).toMatchObject({ status: "ready", byteSize: 3, retireAt: "2027-02-28T01:00:00.000Z" });
    clock = new Date("2026-12-01T00:00:00.000Z");
    expect(await api.import(input, openBody)).toEqual(file);
    expect(open).toHaveBeenCalledTimes(1); expect(objects.write).toHaveBeenCalledTimes(1);
  });

  it("recovers a completed object after the inventory update failed", async () => {
    const finish = vi.spyOn(files, "finish").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(useCases().import(input, openBody)).rejects.toThrow("database unavailable");
    clock = new Date("2026-11-30T02:00:00.000Z");
    const file = await useCases().import(input, openBody);
    expect(file.storedAt).toBe("2026-11-30T01:00:00.000Z");
    expect(open).toHaveBeenCalledTimes(1); expect(objects.write).toHaveBeenCalledTimes(1);
    expect(file.checksum).toBe(createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"));
    finish.mockRestore();
  });

  it("does not grant another user or agent access through a file ID", async () => {
    await useCases().import(input, openBody);
    await expect(useCases().read("audio", "file-1", "other@example.test")).rejects.toMatchObject({ status: 404 });
    await expect(useCases().read("other", "file-1", input.userEmail)).rejects.toMatchObject({ status: 404 });
    await expect(useCases().import({ ...input, userEmail: "other@example.test" }, openBody)).rejects.toMatchObject({ status: 404 });
    await expect(useCases().import({ ...input, agentName: "other" }, openBody)).rejects.toThrow();
    expect(objects.write).toHaveBeenCalledTimes(1);
  });

  it("refuses reads at expiry and deletes bytes before marking inventory deleted", async () => {
    const file = await useCases().import(input, openBody);
    clock = new Date(file.retireAt);
    await expect(useCases().read("audio", "file-1", input.userEmail)).rejects.toMatchObject({ status: 409 });
    expect(await useCases().sweep()).toEqual({ deleted: 1, failed: 0 });
    expect(await files.get("audio", "file-1")).toMatchObject({ status: "deleted" });
    expect(contents.size).toBe(0);
    await expect(useCases().import(input, openBody)).rejects.toMatchObject({ status: 409 });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("retries failed deletion without losing the inventory", async () => {
    const file = await useCases().import(input, openBody); clock = new Date(file.retireAt);
    vi.mocked(objects.delete).mockRejectedValueOnce(new Error("storage offline"));
    expect(await useCases().sweep()).toEqual({ deleted: 0, failed: 1 });
    expect(await files.get("audio", "file-1")).toMatchObject({ status: "deleting" });
    expect(await useCases().sweep()).toEqual({ deleted: 1, failed: 0 });
  });

  it("expires abandoned pending uploads and fences their late completion", async () => {
    vi.mocked(objects.write).mockRejectedValueOnce(new Error("upload interrupted"));
    await expect(useCases().import(input, openBody)).rejects.toThrow();
    const pending = (await files.get("audio", "file-1"))!;
    clock = new Date(pending.retireAt);
    expect(await useCases().sweep()).toEqual({ deleted: 1, failed: 0 });
    expect(await files.finish(pending, { storedAt: clock.toISOString(), retireAt: "2027-02-28T01:00:00.000Z",
      checksum: "late", byteSize: 3 })).toBeNull();
  });

  it("recovers a completed upload during the abandoned-upload sweep instead of deleting it early", async () => {
    const finish = vi.spyOn(files, "finish").mockRejectedValueOnce(new Error("database unavailable"));
    await expect(useCases().import(input, openBody)).rejects.toThrow();
    clock = new Date("2026-12-02T01:00:00.000Z");
    expect(await useCases().sweep()).toEqual({ deleted: 0, failed: 0 });
    expect(await files.get("audio", "file-1")).toMatchObject({ status: "ready", retireAt: "2027-02-28T01:00:00.000Z" });
    expect(objects.delete).not.toHaveBeenCalled();
    expect(contents.size).toBe(1);
    finish.mockRestore();
  });
});
