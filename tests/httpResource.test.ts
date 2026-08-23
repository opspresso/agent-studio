import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResourceError } from "@/domain/net/httpResource";

/**
 * The outbound adapter for addresses a *model* chose.
 *
 * `fetchPublicUrl` is stubbed rather than the global fetch: the guard itself has
 * its own tests, and what needs pinning here is what this adapter does around it
 * — the cap, the headers it does and does not send, and the fact that a refusal
 * is generalised before a model ever sees it.
 */
const { calls, stub } = vi.hoisted(() => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stub = {
    impl: async (_url: string, _init?: RequestInit): Promise<Response> =>
      new Response("", { status: 200 }),
  };
  return { calls, stub };
});

vi.mock("@/infrastructure/net/publicFetch", async () => {
  const actual = await vi.importActual<typeof import("@/infrastructure/net/publicFetch")>(
    "@/infrastructure/net/publicFetch",
  );
  return {
    ...actual,
    fetchPublicUrl: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return stub.impl(url, init);
    },
  };
});

const { createHttpResourceReader, parseContentType, charsetFromHtml } = await import(
  "@/infrastructure/net/httpResource"
);
const { SsrfError } = await import("@/infrastructure/net/ssrfGuard");

/** No declared suffix: every address faces the guard, which is the default. */
const httpResourceReader = createHttpResourceReader({});

const read = (over: { maxBytes?: number } = {}) =>
  httpResourceReader.read({
    url: "https://example.test/a",
    accept: "*/*",
    maxBytes: over.maxBytes ?? 1_000_000,
  });

beforeEach(() => {
  calls.length = 0;
  stub.impl = async () => new Response("", { status: 200 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseContentType", () => {
  it("splits the type from the charset", () => {
    expect(parseContentType("text/html; charset=EUC-KR")).toEqual({
      mimeType: "text/html",
      charset: "euc-kr",
    });
  });

  it("has no charset when none was declared", () => {
    expect(parseContentType("application/pdf")).toEqual({ mimeType: "application/pdf" });
    expect(parseContentType(null)).toEqual({ mimeType: "" });
  });
});

describe("charsetFromHtml", () => {
  it("reads the meta declaration plenty of servers rely on instead of a header", () => {
    expect(charsetFromHtml(Buffer.from('<meta charset="euc-kr">'))).toBe("euc-kr");
    expect(charsetFromHtml(Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?>'))).toBe(
      "shift_jis",
    );
  });
});

describe("the adapter", () => {
  it("sends no credential of this deployment's", async () => {
    // A redirect cannot forward what was never attached.
    await read();
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-tenant-id")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "user-agent"]);
  });

  it("cuts a body that lies about its length", async () => {
    // The declared length must not decide how much is pulled into memory.
    stub.impl = async () =>
      new Response("x".repeat(5_000), {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "10" },
      });
    await expect(read({ maxBytes: 1_000 })).rejects.toBeInstanceOf(HttpResourceError);
  });

  it("refuses on a declared length over the cap without reading the body", async () => {
    stub.impl = async () =>
      new Response("x", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "9999999" },
      });
    await expect(read({ maxBytes: 1_000 })).rejects.toThrow(/over the/);
  });

  it("bounds a body that declares no length at all", async () => {
    stub.impl = async () =>
      new Response("y".repeat(3_000), { status: 200, headers: { "content-type": "text/plain" } });
    await expect(read({ maxBytes: 1_000 })).rejects.toThrow(/larger than/);
  });

  it("generalises a refusal, so the network's shape does not leak", async () => {
    // `PublicFetchError` names the host it refused. Handing that to a model
    // turns this into an oracle for which internal names exist.
    stub.impl = async () => {
      throw new SsrfError("URL host resolves to a private or reserved address: internal-billing.corp");
    };
    const error = await read().catch((e) => e);
    expect(error).toBeInstanceOf(HttpResourceError);
    expect(error.message).toBe("that address is not reachable from here");
    expect(error.message).not.toContain("internal-billing");
  });

  it("says a non-2xx was a non-2xx", async () => {
    stub.impl = async () => new Response("nope", { status: 404 });
    await expect(read()).rejects.toThrow("the server answered 404");
  });

  it("reports a timeout as one", async () => {
    stub.impl = async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    await expect(read()).rejects.toThrow("the request timed out");
  });

  it("prefers the header's charset and falls back to the document's", async () => {
    stub.impl = async () =>
      new Response('<meta charset="euc-kr">', {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    expect((await read()).charset).toBe("utf-8");

    stub.impl = async () =>
      new Response('<meta charset="euc-kr">', {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    expect((await read()).charset).toBe("euc-kr");
  });
});

/**
 * The one way past the guard, for an on-premises install where the pages a
 * model should read are private by construction. The list is injected — the
 * adapter reads no configuration — and it is the FetchUrl list, not the MCP
 * one. Here the *global* fetch is stubbed, because that is what the unguarded
 * path uses: `fetchPublicUrl` must not be touched for a declared host, and must
 * still be the only path for everything else.
 */
describe("a declared internal host", () => {
  const INTERNAL = ["corp.internal"];
  const reader = createHttpResourceReader({ internalHostSuffixes: INTERNAL });
  const fetched: Array<{ url: string; init?: RequestInit }> = [];
  let direct = async (_url: string, _init?: RequestInit): Promise<Response> =>
    new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });

  beforeEach(() => {
    fetched.length = 0;
    direct = async () =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      fetched.push({ url: String(input), init });
      return direct(String(input), init);
    });
    // The guard must not be reached at all for a declared host; if it is, it
    // refuses, which is how the assertion below also catches a wrong path.
    stub.impl = async () => {
      throw new SsrfError("URL host resolves to a private or reserved address: corp.internal");
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const readInternal = (url = "http://wiki.corp.internal/page") =>
    reader.read({ url, accept: "text/*", maxBytes: 1_000_000 });

  it("is fetched without the address guard", async () => {
    const resource = await readInternal();
    expect(Buffer.from(resource.bytes).toString()).toBe("hello");
    expect(resource.finalUrl).toBe("http://wiki.corp.internal/page");
    expect(fetched.map((f) => f.url)).toEqual(["http://wiki.corp.internal/page"]);
    expect(calls).toHaveLength(0);
  });

  it("sends the same two headers, follows nothing natively, and is bounded by a timeout", async () => {
    await readInternal();
    const init = fetched[0]?.init;
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(["accept", "user-agent"]);
    expect(headers.get("authorization")).toBeNull();
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still sends every other address through the guard", async () => {
    // A private address that is not a declared name, a name adjacent to the
    // suffix, and an IP literal: none of them is the exemption.
    for (const url of [
      "http://10.0.0.5/admin",
      "http://evil-corp.internal/",
      "http://corp.internal.evil.test/",
      "http://192.168.1.1/",
    ]) {
      fetched.length = 0;
      calls.length = 0;
      await expect(readInternal(url)).rejects.toThrow("that address is not reachable from here");
      expect(fetched).toHaveLength(0);
      expect(calls.map((c) => c.url)).toEqual([url]);
    }
  });

  it("follows a redirect that stays on the declared host", async () => {
    direct = async (url) =>
      url.endsWith("/page")
        ? new Response(null, { status: 302, headers: { location: "/moved" } })
        : new Response("moved", { status: 200, headers: { "content-type": "text/plain" } });
    const resource = await readInternal();
    expect(Buffer.from(resource.bytes).toString()).toBe("moved");
    expect(resource.finalUrl).toBe("http://wiki.corp.internal/moved");
    expect(fetched.map((f) => f.url)).toEqual([
      "http://wiki.corp.internal/page",
      "http://wiki.corp.internal/moved",
    ]);
  });

  it("refuses a redirect that leaves the declared set, without following it", async () => {
    direct = async () =>
      new Response(null, { status: 302, headers: { location: "https://attacker.example/" } });
    const error = await readInternal().catch((e) => e);
    expect(error).toBeInstanceOf(HttpResourceError);
    expect(error.message).toBe("that address is not reachable from here");
    expect(error.message).not.toContain("attacker");
    expect(fetched.map((f) => f.url)).toEqual(["http://wiki.corp.internal/page"]);
    expect(calls).toHaveLength(0);
  });

  it("refuses a redirect to another declared host, because it is another origin", async () => {
    // Still inside the set, but a redirect may not change origin any more than
    // the guarded path lets it — the exemption is not a licence to hop.
    direct = async () =>
      new Response(null, { status: 302, headers: { location: "http://docs.corp.internal/" } });
    await expect(readInternal()).rejects.toThrow("that address is not reachable from here");
    expect(fetched).toHaveLength(1);
  });

  it("caps the number of hops", async () => {
    direct = async () =>
      new Response(null, { status: 302, headers: { location: "/again" } });
    await expect(readInternal()).rejects.toThrow("that address is not reachable from here");
    expect(fetched).toHaveLength(6);
  });

  it("reports a non-2xx and a timeout the same way as the guarded path", async () => {
    direct = async () => new Response("nope", { status: 503 });
    await expect(readInternal()).rejects.toThrow("the server answered 503");

    direct = async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    await expect(readInternal()).rejects.toThrow("the request timed out");
  });

  it("is not admitted by an empty list", async () => {
    await expect(httpResourceReader.read({ url: "http://wiki.corp.internal/page", accept: "*/*", maxBytes: 1 }))
      .rejects.toThrow("that address is not reachable from here");
    expect(fetched).toHaveLength(0);
  });
});
