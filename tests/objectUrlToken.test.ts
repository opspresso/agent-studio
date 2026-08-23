process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";

// The wrapper reads the access mode and the public base per call; both are
// pinned here so the test is about which address it answers with.
const settings = vi.hoisted(() => ({
  getArtifactAccessMode: vi.fn(),
  getPublicBaseUrl: vi.fn(),
}));
vi.mock("@/lib/runtime-settings", () => settings);

const { objectUrlSignature, proxiedObjectPath, verifyObjectUrlToken } = await import(
  "@/infrastructure/storage/objectUrlToken"
);
const { withArtifactAccessMode } = await import("@/infrastructure/storage/artifactAccess");

const KEY = "artifacts/image/8f0c1d2e-3b4a-4c5d-9e6f-7a8b9c0d1e2f.png";
const NOW = 1_756_000_000;

describe("the proxied object token", () => {
  it("opens exactly the claims it was minted over", () => {
    const claims = { key: KEY, exp: NOW + 900 };
    const sig = objectUrlSignature(claims);
    expect(sig).toBe(objectUrlSignature({ ...claims }));
    expect(verifyObjectUrlToken(claims, sig, NOW)).toBe(true);
    expect(verifyObjectUrlToken({ ...claims, key: "artifacts/image/other.png" }, sig, NOW)).toBe(
      false,
    );
    expect(verifyObjectUrlToken({ ...claims, exp: claims.exp + 1 }, sig, NOW)).toBe(false);
    expect(verifyObjectUrlToken(claims, `${sig.slice(0, -1)}x`, NOW)).toBe(false);
    expect(verifyObjectUrlToken(claims, "", NOW)).toBe(false);
  });

  it("stops answering at its expiry, and never for an expiry that is not a whole second", () => {
    const claims = { key: KEY, exp: NOW + 60 };
    const sig = objectUrlSignature(claims);
    expect(verifyObjectUrlToken(claims, sig, NOW + 59)).toBe(true);
    expect(verifyObjectUrlToken(claims, sig, NOW + 60)).toBe(false);
    expect(verifyObjectUrlToken(claims, sig, NOW + 61)).toBe(false);
    const fractional = { key: KEY, exp: NOW + 60.5 };
    expect(verifyObjectUrlToken(fractional, objectUrlSignature(fractional), NOW)).toBe(false);
    const unparsed = { key: KEY, exp: Number.NaN };
    expect(verifyObjectUrlToken(unparsed, objectUrlSignature(unparsed), NOW)).toBe(false);
  });

  it("binds the filename, so a download cannot become a view or the reverse", () => {
    const view = { key: KEY, exp: NOW + 900 };
    const download = { ...view, downloadAs: "보고서.png" };
    const viewSig = objectUrlSignature(view);
    const downloadSig = objectUrlSignature(download);
    expect(viewSig).not.toBe(downloadSig);
    expect(verifyObjectUrlToken(download, viewSig, NOW)).toBe(false);
    expect(verifyObjectUrlToken(view, downloadSig, NOW)).toBe(false);
    expect(verifyObjectUrlToken({ ...download, downloadAs: "other.png" }, downloadSig, NOW)).toBe(
      false,
    );
    expect(verifyObjectUrlToken(download, downloadSig, NOW)).toBe(true);
  });

  it("writes a path the route reads back as the same claims", () => {
    const claims = { key: "artifacts/document/a b.pdf", exp: NOW + 900, downloadAs: "보고서|1.pdf" };
    const url = new URL(`https://studio.example.com${proxiedObjectPath(claims)}`);
    expect(url.pathname).toBe("/api/objects/artifacts/document/a%20b.pdf");
    const key = url.pathname
      .slice("/api/objects/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    expect(key).toBe(claims.key);
    expect(url.searchParams.get("exp")).toBe(String(claims.exp));
    expect(url.searchParams.get("dl")).toBe(claims.downloadAs);
    expect(
      verifyObjectUrlToken(
        { key, exp: Number(url.searchParams.get("exp")), downloadAs: url.searchParams.get("dl")! },
        url.searchParams.get("sig")!,
        NOW,
      ),
    ).toBe(true);
    expect(proxiedObjectPath({ key: KEY, exp: NOW + 900 })).not.toContain("dl=");
  });
});

describe("withArtifactAccessMode", () => {
  const store: ArtifactObjectStore = {
    put: vi.fn(),
    read: vi.fn(),
    sign: vi.fn(async () => "https://store.example.com/presigned"),
    delete: vi.fn(),
  };
  const addressed = withArtifactAccessMode(store);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    settings.getPublicBaseUrl.mockResolvedValue("https://studio.example.com/");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with this app's address in proxied mode, bound to the caller's lifetime", async () => {
    settings.getArtifactAccessMode.mockResolvedValue("proxied");
    const url = new URL(await addressed.sign(KEY, 900, { downloadAs: "그림.png" }));
    expect(url.origin).toBe("https://studio.example.com");
    expect(url.pathname).toBe(`/api/objects/${KEY}`);
    expect(url.searchParams.get("exp")).toBe(String(NOW + 900));
    expect(url.searchParams.get("dl")).toBe("그림.png");
    expect(
      verifyObjectUrlToken(
        { key: KEY, exp: NOW + 900, downloadAs: "그림.png" },
        url.searchParams.get("sig")!,
        NOW,
      ),
    ).toBe(true);
    expect(store.sign).not.toHaveBeenCalled();
  });

  it("treats an empty filename as none, the way the adapter does", async () => {
    settings.getArtifactAccessMode.mockResolvedValue("proxied");
    const url = new URL(await addressed.sign(KEY, 900, { downloadAs: "" }));
    expect(url.searchParams.has("dl")).toBe(false);
    expect(
      verifyObjectUrlToken({ key: KEY, exp: NOW + 900 }, url.searchParams.get("sig")!, NOW),
    ).toBe(true);
  });

  it.each(["authenticated", "public"] as const)(
    "leaves the %s address to the store itself",
    async (mode) => {
      settings.getArtifactAccessMode.mockResolvedValue(mode);
      await expect(addressed.sign(KEY, 900, { downloadAs: "x.png" })).resolves.toBe(
        "https://store.example.com/presigned",
      );
      expect(store.sign).toHaveBeenCalledWith(KEY, 900, { downloadAs: "x.png" });
      expect(settings.getPublicBaseUrl).not.toHaveBeenCalled();
    },
  );

  it("passes the other operations through untouched", async () => {
    await addressed.put({ key: KEY, bytes: Uint8Array.from([1]), mimeType: "image/png" });
    await addressed.read(KEY, 10);
    await addressed.delete(KEY);
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.read).toHaveBeenCalledWith(KEY, 10);
    expect(store.delete).toHaveBeenCalledWith(KEY);
  });
});
