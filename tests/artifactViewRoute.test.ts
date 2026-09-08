import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/app/_i18n/translate";
import { ARTIFACT_VIEW_POLICY, INTERACTIVE_HTML_VIEW_POLICY } from "@/app/api/artifacts/[artifactId]/view/_lib/htmlSafety";

const state = vi.hoisted(() => ({ authenticated: true, read: vi.fn() }));
vi.mock("@/lib/container", () => ({ artifactUseCases: { readForView: state.read } }));
vi.mock("@/lib/session", () => ({
  withAuth: (handler: (user: { email: string }, request: Request, context: unknown) => Promise<Response>) =>
    (request: Request, context: unknown) => state.authenticated
      ? handler({ email: "owner@example.com" }, request, context)
      : Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 })),
}));
vi.mock("@/app/_i18n/server", () => ({ getT: async () => translator("en") }));
import { GET } from "@/app/api/artifacts/[artifactId]/view/route";

const request = new Request("http://localhost/api/artifacts/file/view");
const context = { params: Promise.resolve({ artifactId: "file" }) };
beforeEach(() => { state.authenticated = true; state.read.mockReset(); });

describe("artifact view route policy", () => {
  it("authorizes HTML before returning only the isolated wrapper", async () => {
    state.read.mockResolvedValue({ artifact: { filename: "demo.html", mimeType: "text/html" }, view: "html", bytes: Buffer.from('<script id="user-code">alert(1)</script>') });
    const response = await GET(request, context);
    expect(state.read).toHaveBeenCalledWith("file", "owner@example.com");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(INTERACTIVE_HTML_VIEW_POLICY);
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).not.toContain('<script id="user-code">');
    expect(html).toContain('sandbox="allow-scripts"');
  });

  it("keeps non-HTML files under the script-free policy", async () => {
    state.read.mockResolvedValue({ artifact: { filename: "note.txt", mimeType: "text/plain" }, view: "text", bytes: Buffer.from('<script>alert(1)</script>') });
    const response = await GET(request, context);
    expect(response.headers.get("Content-Security-Policy")).toBe(ARTIFACT_VIEW_POLICY);
    expect(await response.text()).not.toContain("<script>");
  });

  it("rejects invalid HTML encoding without returning a script-capable error", async () => {
    state.read.mockResolvedValue({ artifact: { filename: "bad.html", mimeType: "text/html" }, view: "html", bytes: Uint8Array.of(0xff) });
    const response = await GET(request, context);
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not read bytes for unauthenticated callers", async () => {
    state.authenticated = false;
    const response = await GET(request, context);
    expect(response.status).toBe(401);
    expect(state.read).not.toHaveBeenCalled();
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });
});
