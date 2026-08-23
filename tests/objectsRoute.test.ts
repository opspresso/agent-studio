process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectNotFoundError } from "@/domain/artifact/objectStore";
import nextConfig from "../next.config";

// Route-handler test: the store is a fake and the verifier is the real one, so
// the assertions are about what the route decides — what it refuses, what it
// serves, and the terms it serves it under.
const { store } = vi.hoisted(() => ({
  store: { put: vi.fn(), read: vi.fn(), sign: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/lib/container", async () => ({
  proxiedObjects: (
    await import("@/infrastructure/storage/artifactAccess")
  ).createProxiedObjectAccess(store as never),
}));
vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: { get: vi.fn(async () => null), put: vi.fn() },
}));

const { GET } = await import("@/app/api/objects/[...key]/route");
const { proxiedObjectPath } = await import("@/infrastructure/storage/objectUrlToken");
const { getArtifactAccessMode, invalidateSettingsCache } = await import("@/lib/runtime-settings");

const KEY = "artifacts/document/8f0c1d2e-3b4a-4c5d-9e6f-7a8b9c0d1e2f.pdf";
const NOW = 1_756_000_000;
const TEN_MB = 10 * 1024 * 1024;

/** The request as Next hands it over: the catch-all's decoded segments beside the URL. */
function get(pathAndQuery: string): Promise<Response> {
  const url = new URL(`https://studio.example.com${pathAndQuery}`);
  const key = url.pathname.slice("/api/objects/".length).split("/").map(decodeURIComponent);
  return GET(new Request(url), { params: Promise.resolve({ key }) });
}

const signed = (claims: { exp?: number; downloadAs?: string } = {}) =>
  proxiedObjectPath({ key: KEY, exp: claims.exp ?? NOW + 900, downloadAs: claims.downloadAs });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  store.read.mockResolvedValue({ bytes: Uint8Array.from([37, 80, 68, 70]), mimeType: "application/pdf" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/objects/[...key]", () => {
  it("serves the object a valid token names, under the token's remaining life", async () => {
    const res = await get(signed({ exp: NOW + 300 }));
    expect(res.status).toBe(200);
    expect(store.read).toHaveBeenCalledWith(KEY, TEN_MB);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from([37, 80, 68, 70]));
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("names the file a download was signed for, RFC 5987 encoded", async () => {
    const res = await get(signed({ downloadAs: "보고서 1.pdf" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%201.pdf",
    );
  });

  it("sandboxes what a browser would render as a page, and only that", async () => {
    store.read.mockResolvedValue({ bytes: Uint8Array.from([60]), mimeType: "text/html; charset=utf-8" });
    const page = await get(signed());
    expect(page.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    store.read.mockResolvedValue({ bytes: Uint8Array.from([60]), mimeType: "image/svg+xml" });
    const svg = await get(signed());
    expect(svg.headers.get("Content-Security-Policy")).toContain("sandbox");
    store.read.mockResolvedValue({ bytes: Uint8Array.from([1]), mimeType: "image/png" });
    const picture = await get(signed());
    expect(picture.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    const pdf = await get(signed());
    expect(pdf.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });

  it("refuses a token that was tampered with, without reading the store", async () => {
    const url = new URL(`https://studio.example.com${signed()}`);
    const sig = url.searchParams.get("sig")!;
    url.searchParams.set("sig", `${sig.slice(0, -2)}zz`);
    expect((await get(`${url.pathname}${url.search}`)).status).toBe(403);
    url.searchParams.delete("sig");
    expect((await get(`${url.pathname}${url.search}`)).status).toBe(403);
    // The same signature presented for another key.
    const other = new URL(`https://studio.example.com${signed()}`);
    other.pathname = "/api/objects/artifacts/document/other.pdf";
    expect((await get(`${other.pathname}${other.search}`)).status).toBe(403);
    expect(store.read).not.toHaveBeenCalled();
  });

  it("refuses an expired token, and one whose expiry was pushed out", async () => {
    const url = new URL(`https://studio.example.com${signed({ exp: NOW + 10 })}`);
    vi.setSystemTime((NOW + 10) * 1000);
    expect((await get(`${url.pathname}${url.search}`)).status).toBe(403);
    url.searchParams.set("exp", String(NOW + 10_000));
    expect((await get(`${url.pathname}${url.search}`)).status).toBe(403);
    expect(store.read).not.toHaveBeenCalled();
  });

  it("refuses a download link with its filename dropped, and a view link with one added", async () => {
    const download = new URL(`https://studio.example.com${signed({ downloadAs: "x.pdf" })}`);
    download.searchParams.delete("dl");
    expect((await get(`${download.pathname}${download.search}`)).status).toBe(403);
    const view = new URL(`https://studio.example.com${signed()}`);
    view.searchParams.set("dl", "x.pdf");
    expect((await get(`${view.pathname}${view.search}`)).status).toBe(403);
    expect(store.read).not.toHaveBeenCalled();
  });

  it("answers 404 for an object the store no longer holds, and 500 for anything else", async () => {
    store.read.mockRejectedValueOnce(new ObjectNotFoundError(KEY));
    const gone = await get(signed());
    expect(gone.status).toBe(404);
    expect(gone.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(gone.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.read.mockRejectedValueOnce(new Error("stored object exceeds the read limit"));
    const failed = await get(signed());
    expect(failed.status).toBe(500);
    expect(failed.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("carries the refusal headers on a 403 too, since the console's rule leaves this address alone", async () => {
    const res = await get(`/api/objects/${KEY}?exp=1&sig=x`);
    expect(res.status).toBe(403);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("the proxied access mode", () => {
  const saved = process.env.ARTIFACT_ACCESS_MODE;

  afterEach(() => {
    if (saved === undefined) delete process.env.ARTIFACT_ACCESS_MODE;
    else process.env.ARTIFACT_ACCESS_MODE = saved;
    invalidateSettingsCache();
  });

  it("is a value the runtime setting resolves to", async () => {
    invalidateSettingsCache();
    process.env.ARTIFACT_ACCESS_MODE = "proxied";
    await expect(getArtifactAccessMode()).resolves.toBe("proxied");
  });

  it("is the second address the console's headers leave alone", async () => {
    const rules = await nextConfig.headers!();
    const pattern = new RegExp(`^${rules[0]!.source}$`);
    expect(pattern.test(`/api/objects/${KEY}`)).toBe(false);
    expect(pattern.test("/api/objects/artifacts/image/a.png")).toBe(false);
    // The subtree only — a sibling address keeps the console's rule.
    expect(pattern.test("/api/objects")).toBe(true);
    expect(pattern.test("/api/objectstore/a")).toBe(true);
    expect(pattern.test("/api/artifacts")).toBe(true);
  });
});
