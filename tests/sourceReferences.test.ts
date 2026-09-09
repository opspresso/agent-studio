import { describe, expect, it, vi } from "vitest";
import { createSourceReferenceUseCases, type SourceReferenceDeps } from "@/application/audio/sourceReferences";
import type { SourceReference } from "@/domain/artifact/sourceReference";
import { sourceReferenceContext } from "@/domain/security/secretContext";
import type { AudioJob } from "@/domain/audio/job";
import { NotFoundError } from "@/application/errors";

function fixture() {
  const rows = new Map<string, SourceReference>();
  let now = new Date("2026-09-09T00:00:00Z");
  const deps: SourceReferenceDeps = {
    references: { put: async (value) => { rows.set(value.id, value); }, get: async (id) => rows.get(id) ?? null },
    cipher: { encrypt: vi.fn(() => "ciphertext"), decrypt: vi.fn(() => "https://files.example.test/audio?sig=private") },
    urlPolicy: { assertAllowed: vi.fn(async () => {}) }, downloader: { open: vi.fn() },
    files: { import: vi.fn(), read: vi.fn(), metadata: vi.fn(), sweep: vi.fn() },
    authorize: vi.fn(async () => {}), now: () => now, id: () => "ref-1",
  };
  const input = { projectName: "audio", userEmail: "owner@example.test", namespace: "account-1", itemId: "external-1",
    filename: "audio.mp3", mimeType: "audio/mpeg", url: "https://files.example.test/audio?sig=private" };
  return { api: createSourceReferenceUseCases(deps), deps, input, rows, advance: (value: string) => { now = new Date(value); } };
}

describe("encrypted source references", () => {
  it("refreshes an admitted source after its temporary reference row has expired", async () => {
    const f = fixture();
    const refresh = { serverName: "files", versionName: "1", identity: "connection-1", mapping: {
      tool: "get_file", namespace: "account", urlPath: ["url"], idPath: ["id"], mimeType: "audio/mpeg", refreshArgument: "file_id",
    } };
    await f.api.register({ ...f.input, refresh });
    const identity = await f.api.identity("audio", "ref-1", f.input.userEmail);
    f.rows.clear();
    f.deps.refresh = vi.fn(async () => ({ ...f.input, url: "https://files.example.test/new?sig=fresh" }));
    vi.mocked(f.deps.files.metadata).mockRejectedValue(new NotFoundError("missing"));
    vi.mocked(f.deps.downloader.open).mockResolvedValue({ body: (async function* () { yield new Uint8Array([1]); })(), mimeType: "audio/mpeg" });
    vi.mocked(f.deps.files.import).mockImplementation(async (input, open) => {
      for await (const _part of await open(100)) { /* consume */ }
      return { ...input, status: "ready", revision: 2, createdAt: "now", retireAt: "later" };
    });
    const job: AudioJob = { id: "job", projectName: "audio", userEmail: f.input.userEmail, source: { kind: "source", sourceRef: "ref-1" },
      sourceKey: "key", sourceIdentity: identity, sourceRefresh: identity.refresh, model: "asr", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" },
      revision: 1, status: "running", stage: "importing", createdAt: "now", updatedAt: "now", dueAt: "now", attempt: 1, failures: 0, receipts: {} };
    const context = { signal: new AbortController().signal, record: async () => {} };
    expect(await f.api.importFile(job, context)).toEqual({ fileId: "job-source" });
    expect(f.deps.refresh).toHaveBeenCalledTimes(1);
    expect(f.deps.downloader.open).toHaveBeenCalledWith("https://files.example.test/new?sig=fresh", context.signal, 100);
    expect(f.deps.cipher.decrypt).not.toHaveBeenCalled();
    vi.mocked(f.deps.refresh).mockResolvedValue({ ...f.input, itemId: "another-item" });
    await expect(f.api.importFile(job, context)).rejects.toThrow("source_identity_changed");
    expect(f.deps.downloader.open).toHaveBeenCalledTimes(1);
  });
  it("returns an opaque reference and encrypts the URL with its project-bound context", async () => {
    const f = fixture();
    expect(await f.api.register(f.input)).toEqual({ sourceRef: "ref-1", filename: "audio.mp3", mimeType: "audio/mpeg" });
    expect(f.deps.cipher.encrypt).toHaveBeenCalledWith(f.input.url, sourceReferenceContext("audio", "ref-1"));
    expect(JSON.stringify(f.rows.get("ref-1"))).not.toContain("sig=private");
    expect(await f.api.identity("audio", "ref-1", f.input.userEmail)).toEqual({ namespace: "account-1", itemId: "external-1" });
  });
  it("does not reveal another user or project's reference", async () => {
    const f = fixture(); await f.api.register(f.input);
    await expect(f.api.identity("other", "ref-1", f.input.userEmail)).rejects.toMatchObject({ status: 404 });
    await expect(f.api.identity("audio", "ref-1", "other@example.test")).rejects.toMatchObject({ status: 404 });
  });
  it("rejects expired references even before the TTL sweep removes them", async () => {
    const f = fixture(); await f.api.register(f.input); f.advance("2026-09-10T00:00:00Z");
    await expect(f.api.identity("audio", "ref-1", f.input.userEmail)).rejects.toThrow("source_reference_expired");
  });
  it("does not persist a URL refused by the outbound policy", async () => {
    const f = fixture(); f.deps.urlPolicy.assertAllowed = async () => { throw new Error("private DNS details"); };
    await expect(f.api.register(f.input)).rejects.toThrow("Source URL is not permitted");
    expect(f.rows.size).toBe(0);
  });
  it("reuses an imported file even after the temporary source reference expires", async () => {
    const f = fixture(); await f.api.register(f.input); f.advance("2026-09-10T00:00:00Z");
    const retention = { unit: "months" as const, value: 3, timezone: "Asia/Seoul" };
    const file = { id: "job-1-source", projectName: "audio", userEmail: f.input.userEmail, filename: "audio.mp3",
      mimeType: "audio/mpeg", retention, status: "ready" as const, revision: 2,
      createdAt: "2026-09-09T00:00:00Z", retireAt: "2026-12-09T00:00:00Z" };
    vi.mocked(f.deps.files.metadata).mockResolvedValue(file);
    vi.mocked(f.deps.files.import).mockResolvedValue(file);
    const job: AudioJob = { id: "job-1", projectName: "audio", userEmail: f.input.userEmail,
      source: { kind: "source", sourceRef: "ref-1" }, sourceKey: "stable", model: "asr", retention,
      revision: 1, status: "running", stage: "importing", createdAt: file.createdAt, updatedAt: file.createdAt,
      dueAt: file.createdAt, attempt: 1, failures: 0, receipts: {} };
    expect(await f.api.importFile(job, { signal: new AbortController().signal, record: async () => {} }))
      .toEqual({ fileId: file.id });
    expect(f.deps.cipher.decrypt).not.toHaveBeenCalled();
    expect(f.deps.downloader.open).not.toHaveBeenCalled();
  });
});
