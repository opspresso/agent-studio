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

const { httpResourceReader, parseContentType, charsetFromHtml } = await import(
  "@/infrastructure/net/httpResource"
);
const { SsrfError } = await import("@/infrastructure/net/ssrfGuard");

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
