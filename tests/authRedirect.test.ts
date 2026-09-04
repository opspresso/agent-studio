import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loginHref,
  redirectApiUnauthorized,
  redirectToLogin,
  type BrowserLocation,
} from "@/app/_lib/authRedirect";
import { readJson } from "@/app/_lib/httpClient";
import { isPublicPagePath } from "@/shared/pageAccess";

function location(pathname = "/projects/sample") {
  const replace = vi.fn<(url: string) => void>();
  return {
    origin: "https://studio.example.com",
    pathname,
    search: "?tab=usage",
    hash: "#daily",
    replace,
  } satisfies BrowserLocation;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("expired session redirect", () => {
  it("preserves the current path, query, and fragment as the post-login destination", () => {
    expect(loginHref(location())).toBe(
      "/login?next=%2Fprojects%2Fsample%3Ftab%3Dusage%23daily",
    );
  });

  it("redirects protected pages but leaves the two public pages alone", () => {
    const protectedLocation = location();
    expect(redirectToLogin(protectedLocation)).toBe(true);
    expect(protectedLocation.replace).toHaveBeenCalledWith(
      "/login?next=%2Fprojects%2Fsample%3Ftab%3Dusage%23daily",
    );

    expect(isPublicPagePath("/")).toBe(true);
    expect(isPublicPagePath("/login")).toBe(true);
    expect(isPublicPagePath("/projects")).toBe(false);
    expect(redirectToLogin(location("/login"))).toBe(false);
  });

  it("redirects only same-origin API 401 responses", () => {
    const current = location();
    expect(
      redirectApiUnauthorized(
        { status: 401, url: "https://studio.example.com/api/me" },
        current,
      ),
    ).toBe(true);
    expect(
      redirectApiUnauthorized(
        { status: 401, url: "https://provider.example.com/api/models" },
        location(),
      ),
    ).toBe(false);
    expect(
      redirectApiUnauthorized(
        { status: 403, url: "https://studio.example.com/api/me" },
        location(),
      ),
    ).toBe(false);
  });

  it("makes the shared JSON reader redirect before surfacing a 401 error", async () => {
    const current = location();
    vi.stubGlobal("window", { location: current });

    await expect(
      readJson(new Response('{"error":"Unauthorized"}', { status: 401 })),
    ).rejects.toThrow("Authentication required");
    expect(current.replace).toHaveBeenCalledOnce();
  });
});
