import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { createSourceFileUseCases } from "@/application/artifact/sourceFiles";
import type { SourceObjectStore } from "@/domain/artifact/sourceObjectStore";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { sourceFileRepository as files } from "@/infrastructure/db/repositories/sourceFileRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
let clock: Date;
let contents: Map<string, { bytes: Uint8Array; mimeType: string; storedAt: string }>;
let objects: SourceObjectStore;
const input = { id: "file-1", projectName: "audio", userEmail: "owner@example.test", filename: "audio.mp3",
  mimeType: "audio/mpeg", retention: { unit: "months" as const, value: 3, timezone: "Asia/Seoul" } };
const open = vi.fn(async function* () { yield new Uint8Array([1, 2, 3]); });
const useCases = () => createSourceFileUseCases({ files, objects, now: () => clock });
beforeEach(() => {
  vi.clearAllMocks(); fake.rows.clear(); fake.seed([
    { ...keys.project("audio"), entityType: "PROJECT" }, { ...keys.project("other"), entityType: "PROJECT" },
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
  it("closes the opened download when storage refuses it before reading", async () => {
    const close = vi.fn(async () => {});
    vi.mocked(objects.write).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(useCases().import(input, async () => Object.assign(open(), { close }))).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("does not open an upload for a project being deleted", async () => {
    fake.seed([{ ...keys.project("audio"), entityType: "PROJECT", deletingAt: clock.toISOString() }]);
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

  it("does not grant another user or project access through a file ID", async () => {
    await useCases().import(input, openBody);
    await expect(useCases().read("audio", "file-1", "other@example.test")).rejects.toMatchObject({ status: 404 });
    await expect(useCases().read("other", "file-1", input.userEmail)).rejects.toMatchObject({ status: 404 });
    await expect(useCases().import({ ...input, userEmail: "other@example.test" }, openBody)).rejects.toMatchObject({ status: 404 });
    await expect(useCases().import({ ...input, projectName: "other" }, openBody)).rejects.toThrow();
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
