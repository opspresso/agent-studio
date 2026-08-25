import { afterEach, describe, expect, it, vi } from "vitest";

const { agentOptions, undiciFetch } = vi.hoisted(() => ({
  agentOptions: [] as Array<{
    connect: {
      lookup: (
        hostname: string,
        options: { all?: boolean },
        callback: (error: Error | null, addresses: unknown, family?: number) => void,
      ) => void;
    };
  }>,
  undiciFetch: vi.fn(),
}));

// `fetch` is mocked alongside `Agent` on purpose: the two travel together. A
// `dispatcher` is a private contract between a fetch implementation and its
// `Agent`, so stubbing the *global* fetch here — which is what this file used to
// do — exercised a pairing the deployment never runs, and hid a runtime whose
// bundled undici was a major behind the one in `package.json`.
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: (typeof agentOptions)[number]) {
      agentOptions.push(options);
    }
    close(): void {}
  },
  fetch: undiciFetch,
}));

const { dnsResults } = vi.hoisted(() => ({ dnsResults: [] as string[][] }));

vi.mock("node:dns/promises", () => ({
  lookup: async () => {
    const next = dnsResults.shift();
    if (!next) {
      throw new Error("no scripted DNS result");
    }
    return next.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

import { fetchPublicUrl, PublicFetchError } from "@/infrastructure/net/publicFetch";
import { SsrfError } from "@/infrastructure/net/ssrfGuard";

afterEach(() => {
  vi.unstubAllGlobals();
  undiciFetch.mockReset();
  agentOptions.length = 0;
  dnsResults.length = 0;
});

describe("fetchPublicUrl", () => {
  it("returns an address array when undici requests all DNS results", async () => {
    undiciFetch.mockResolvedValue(new Response("ok"));

    await fetchPublicUrl("https://93.184.216.34/start");

    const lookup = agentOptions[0]?.connect.lookup;
    expect(lookup).toBeDefined();
    const result = await new Promise<unknown>((resolve, reject) => {
      lookup?.("example.com", { all: true }, (error, addresses) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(addresses);
      });
    });
    expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("blocks a redirect to a private address before dispatching it", async () => {
    undiciFetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
    );

    await expect(fetchPublicUrl("https://93.184.216.34/start")).rejects.toBeInstanceOf(SsrfError);
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(undiciFetch.mock.calls[0]?.[1]).toHaveProperty("dispatcher");
  });

  it("blocks cross-origin redirects so credentials cannot move to another host", async () => {
    undiciFetch.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://93.184.216.35/next" },
      }),
    );

    await expect(
      fetchPublicUrl("https://93.184.216.34/start", {
        headers: { Authorization: "Bearer secret" },
      }),
    ).rejects.toBeInstanceOf(PublicFetchError);
  });

  it("validates and follows a same-origin redirect manually", async () => {
    undiciFetch
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/next" } }))
      .mockResolvedValueOnce(new Response("ok"));

    const response = await fetchPublicUrl("https://93.184.216.34/start");

    expect(await response.text()).toBe("ok");
    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(String(undiciFetch.mock.calls[1]?.[0])).toBe("https://93.184.216.34/next");
  });

  it("cancels every redirect body when the redirect limit is exceeded", async () => {
    const cancel = vi.fn();
    undiciFetch.mockImplementation(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: "/again" },
        }),
    );

    await expect(fetchPublicUrl("https://93.184.216.34/start")).rejects.toBeInstanceOf(
      PublicFetchError,
    );

    expect(undiciFetch).toHaveBeenCalledTimes(6);
    expect(cancel).toHaveBeenCalledTimes(6);
  });
});

describe("fetchPublicUrl transport pairing", () => {
  it("sends through undici's own fetch, never the runtime's global one", async () => {
    // The regression this file exists to prevent. The global `fetch` is the
    // runtime's *bundled* undici, a different copy from the `Agent` above it:
    // pairing them made every outbound request fail with a bare
    // `TypeError: fetch failed` on a Node whose bundled major had drifted, and
    // passed on one where it happened to match.
    const globalFetch = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", globalFetch);
    undiciFetch.mockResolvedValue(new Response("ok"));

    await fetchPublicUrl("https://93.184.216.50/x");

    expect(undiciFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("hands back the runtime's own Response, which callers test with instanceof", async () => {
    // undici answers with its package's `Response`, the same standard but not
    // the same class. The MCP client reads an error body with
    // `input instanceof Response`, so a foreign instance would be reported as
    // its own stringified self rather than what the server said.
    undiciFetch.mockResolvedValue(new Response("ok", { headers: { "x-kind": "answer" } }));

    const response = await fetchPublicUrl("https://93.184.216.51/x");

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kind")).toBe("answer");
    expect(await response.text()).toBe("ok");
  });

  it("keeps repeated set-cookie lines apart", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    undiciFetch.mockResolvedValue(new Response("ok", { headers }));

    const response = await fetchPublicUrl("https://93.184.216.52/x");

    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("carries a bodyless answer back without inventing one", async () => {
    undiciFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await fetchPublicUrl("https://93.184.216.53/x");

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe("fetchPublicUrl dispatcher reuse", () => {
  const dispatcherOf = (call: unknown[] | undefined) =>
    (call?.[1] as { dispatcher?: unknown } | undefined)?.dispatcher;

  it("reuses one dispatcher for repeated requests to the same origin and address", async () => {
    undiciFetch.mockResolvedValue(new Response("ok"));

    await fetchPublicUrl("https://93.184.216.40/one");
    await fetchPublicUrl("https://93.184.216.40/two");

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(dispatcherOf(undiciFetch.mock.calls[0])).toBe(dispatcherOf(undiciFetch.mock.calls[1]));
  });

  it("uses a distinct dispatcher per resolved address", async () => {
    undiciFetch.mockResolvedValue(new Response("ok"));

    await fetchPublicUrl("https://93.184.216.41/x");
    await fetchPublicUrl("https://93.184.216.42/x");

    expect(dispatcherOf(undiciFetch.mock.calls[0])).not.toBe(
      dispatcherOf(undiciFetch.mock.calls[1]),
    );
  });

  it("re-checks DNS every request: a host that starts resolving privately is blocked even when its dispatcher is cached", async () => {
    // The whole point of the cache being transport-only. First request warms
    // the cache for this origin; then the host flips to loopback (DNS
    // rebinding) and the guard must still reject it.
    undiciFetch.mockResolvedValue(new Response("ok"));
    dnsResults.push(["93.184.216.43"], ["127.0.0.1"]);

    await fetchPublicUrl("https://rebind.test/first");
    expect(undiciFetch).toHaveBeenCalledTimes(1);

    await expect(fetchPublicUrl("https://rebind.test/second")).rejects.toBeInstanceOf(SsrfError);
    // Never dispatched — rejected before the cached dispatcher was reached.
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });
});
