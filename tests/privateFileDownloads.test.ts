import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ artifact: vi.fn(), file: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/session", () => ({
  withMemberAuth: (handler: (user: { email: string }, request: Request, context: unknown) => Promise<Response>) =>
    (request: Request, context: unknown) => handler({ email: "owner@example.test" }, request, context),
}));
vi.mock("@/lib/container", () => ({
  artifactUseCases: { readPrivateFile: reads.artifact },
  getAudioRuntime: () => ({ authorize: reads.authorize, files: { read: reads.file } }),
}));
import { GET as downloadArtifact } from "@/app/api/artifacts/[artifactId]/download/route";
import { GET as downloadSource } from "@/app/api/agents/[name]/source-files/[file]/route";

const bytes = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
beforeEach(() => { vi.clearAllMocks(); });

describe.each(["artifact", "source"] as const)("private %s download filenames", (surface) => {
  it.each([
    ["주간 회의", "audio/mpeg", "주간 회의.mp3"],
    ["회의.MP3", "audio/mpeg", "회의.MP3"],
    ["녹음", "audio/wav", "녹음.wav"],
    ["summary.md", "text/markdown", "summary.md"],
  ])("downloads stored %s as %s with the appropriate extension", async (filename, mimeType, expected) => {
    reads.artifact.mockResolvedValue({ artifact: { filename, mimeType }, bytes });
    reads.file.mockResolvedValue({ file: { filename, mimeType }, bytes });
    const request = new Request("https://studio.example.test/download");
    const response = surface === "artifact"
      ? await downloadArtifact(request, { params: Promise.resolve({ artifactId: "artifact-1" }) })
      : await downloadSource(request, { params: Promise.resolve({ name: "audio", file: "file-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(expected)}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    if (surface === "artifact") {
      expect(reads.artifact).toHaveBeenCalledWith("artifact-1", "owner@example.test");
    } else {
      expect(reads.authorize).toHaveBeenCalledWith("audio", "owner@example.test");
      expect(reads.file).toHaveBeenCalledWith("audio", "file-1", "owner@example.test");
    }
  });
});
