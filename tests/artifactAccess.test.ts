import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";

/**
 * In proxied mode the signed address is the app's own. A deployment that has
 * not said where it lives gets a path rather than the dev default: the
 * console resolves it against its own origin, and nothing is sent to
 * `localhost:3000` on a host that is not one.
 */
const settings = vi.hoisted(() => ({
  mode: "proxied" as string,
  base: undefined as string | undefined,
}));
vi.mock("@/lib/runtime-settings", () => ({
  getArtifactAccessMode: async () => settings.mode,
  getPublicBaseUrl: async () => settings.base,
}));

process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { withArtifactAccessMode } = await import("@/infrastructure/storage/artifactAccess");

const inner: ArtifactObjectStore = {
  put: async () => {},
  read: async () => ({ bytes: new Uint8Array(), mimeType: "application/octet-stream" }),
  sign: async (key) => `presigned:${key}`,
  delete: async () => {},
};

beforeEach(() => {
  settings.mode = "proxied";
  settings.base = undefined;
});

describe("withArtifactAccessMode", () => {
  it("signs a path when no public address is configured", async () => {
    const url = await withArtifactAccessMode(inner).sign("artifacts/image/a.png", 60);
    expect(url.startsWith("/api/objects/artifacts/image/a.png?")).toBe(true);
    expect(url).not.toContain("localhost");
  });

  it("prefixes the configured address, without a doubled slash", async () => {
    settings.base = "https://studio.example.com/";
    const url = await withArtifactAccessMode(inner).sign("artifacts/image/a.png", 60);
    expect(url.startsWith("https://studio.example.com/api/objects/")).toBe(true);
  });

  it("leaves the other modes to the store", async () => {
    settings.mode = "authenticated";
    await expect(withArtifactAccessMode(inner).sign("k", 60)).resolves.toBe("presigned:k");
  });
});
