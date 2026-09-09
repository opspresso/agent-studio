import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSourceArtifact } from "@/application/artifact/storeArtifact";
import { createArtifactUseCases } from "@/application/artifact/artifactUseCases";
import { toArtifactViews } from "@/app/api/artifacts/_lib/query";
import { setAdminCheck } from "@/application/project/projectUseCases";
import type { SourceFile } from "@/domain/artifact/sourceFile";
import type { Artifact } from "@/domain/artifact/types";
import type { ProjectRepository } from "@/domain/project/repository";

const file: SourceFile = { id: "audio-file", projectName: "collector", userEmail: "owner@example.test",
  filename: "recording.mp3", mimeType: "audio/mpeg", retention: { value: 3, unit: "months", timezone: "Asia/Seoul" },
  revision: 2, status: "ready", createdAt: "2026-09-09T00:00:00.000Z", storedAt: "2026-09-09T00:00:01.000Z",
  retireAt: "2026-12-09T00:00:01.000Z", byteSize: 100, checksum: "sha256" };

function fixture() {
  const stored = new Map<string, Artifact>();
  const rows = { put: vi.fn(async (a: Artifact) => { stored.set(a.artifactId, a); }),
    get: async (id: string) => stored.get(id) ?? null, delete: vi.fn(async (id: string) => { stored.delete(id); }),
    listByOwner: async () => [...stored.values()], listByProject: async () => [...stored.values()] };
  const objects = { put: vi.fn(), read: vi.fn(), sign: vi.fn(), delete: vi.fn() };
  const privateFiles = { read: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]) })), remove: vi.fn() };
  const projects = { get: async () => ({ name: "collector", ownerEmail: file.userEmail }) } as unknown as ProjectRepository;
  return { rows, objects, privateFiles, api: createArtifactUseCases(rows, objects, projects, privateFiles) };
}
beforeEach(() => { setAdminCheck(async () => false); });
describe("private files in the Artifact inventory", () => {
  it("indexes one stable artifact without storing another object or extending retention", async () => {
    const f = fixture();
    await registerSourceArtifact(f.rows, file); await registerSourceArtifact(f.rows, file);
    expect(await f.api.listMine(file.userEmail)).toEqual([expect.objectContaining({ artifactId: file.id,
      privateFileId: file.id, kind: "audio", ownerEmail: file.userEmail, retireAt: file.retireAt })]);
    expect(f.objects.put).not.toHaveBeenCalled();
    await registerSourceArtifact(f.rows, { ...file, id: "scratch", derived: { jobId: "job", kind: "checkpoint" } });
    expect(await f.rows.get("scratch")).toBeNull();
  });
  it("never invokes a public signer for a private file, even without regular artifact storage", async () => {
    const f = fixture(); await registerSourceArtifact(f.rows, file);
    const a = (await f.rows.get(file.id))!;
    for (const signer of [f.objects.sign, undefined]) {
      expect((await toArtifactViews([a], signer, {})).artifacts[0]?.url).toBe(`/api/artifacts/${file.id}/download`);
    }
    expect(f.objects.sign).not.toHaveBeenCalled();
  });
  it("reads and removes only through the private file lifecycle, not the public bucket", async () => {
    const f = fixture(); await registerSourceArtifact(f.rows, file);
    expect((await f.api.readPrivateFile(file.id, file.userEmail)).bytes).toHaveLength(3);
    await expect(f.api.readPrivateFile(file.id, "other@example.test")).rejects.toThrow("not found");
    await f.api.remove(file.id, file.userEmail);
    expect(f.privateFiles.remove).toHaveBeenCalledWith(file.projectName, file.id, file.userEmail);
    expect(f.objects.delete).not.toHaveBeenCalled();
    expect(await f.rows.get(file.id)).toBeNull();
  });
  it("uses authenticated reads for Markdown previews and propagates expiration failures", async () => {
    const f = fixture();
    await registerSourceArtifact(f.rows, { ...file, mimeType: "text/markdown", filename: "notes.md" });
    expect((await f.api.readForView(file.id, file.userEmail)).view).toBe("markdown");
    expect(f.objects.read).not.toHaveBeenCalled();
    f.privateFiles.read.mockRejectedValueOnce(new Error("expired"));
    await expect(f.api.readForView(file.id, file.userEmail)).rejects.toThrow("expired");
  });
});
