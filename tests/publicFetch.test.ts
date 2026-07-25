import { afterEach, describe, expect, it, vi } from "vitest";

const { agentOptions } = vi.hoisted(() => ({
  agentOptions: [] as Array<{
    connect: {
      lookup: (
        hostname: string,
        options: { all?: boolean },
        callback: (error: Error | null, addresses: unknown, family?: number) => void,
      ) => void;
    };
  }>,
}));

vi.mock("undici", () => ({
  Agent: class {
    constructor(options: (typeof agentOptions)[number]) {
      agentOptions.push(options);
    }
    close(): void {}
  },
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
  agentOptions.length = 0;
  dnsResults.length = 0;
});

describe("fetchPublicUrl", () => {
  it("returns an address array when undici requests all DNS results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));

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
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPublicUrl("https://93.184.216.34/start")).rejects.toBeInstanceOf(SsrfError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toHaveProperty("dispatcher");
  });

  it("blocks cross-origin redirects so credentials cannot move to another host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://93.184.216.35/next" },
        }),
      ),
    );

    await expect(
      fetchPublicUrl("https://93.184.216.34/start", {
        headers: { Authorization: "Bearer secret" },
      }),
    ).rejects.toBeInstanceOf(PublicFetchError);
  });

  it("validates and follows a same-origin redirect manually", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: "/next" } }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchPublicUrl("https://93.184.216.34/start");

    expect(await response.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://93.184.216.34/next");
  });
});

describe("fetchPublicUrl dispatcher reuse", () => {
  const dispatcherOf = (call: unknown[] | undefined) =>
    (call?.[1] as { dispatcher?: unknown } | undefined)?.dispatcher;

  it("reuses one dispatcher for repeated requests to the same origin and address", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPublicUrl("https://93.184.216.40/one");
    await fetchPublicUrl("https://93.184.216.40/two");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dispatcherOf(fetchMock.mock.calls[0])).toBe(dispatcherOf(fetchMock.mock.calls[1]));
  });

  it("uses a distinct dispatcher per resolved address", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchPublicUrl("https://93.184.216.41/x");
    await fetchPublicUrl("https://93.184.216.42/x");

    expect(dispatcherOf(fetchMock.mock.calls[0])).not.toBe(dispatcherOf(fetchMock.mock.calls[1]));
  });

  it("re-checks DNS every request: a host that starts resolving privately is blocked even when its dispatcher is cached", async () => {
    // The whole point of the cache being transport-only. First request warms
    // the cache for this origin; then the host flips to loopback (DNS
    // rebinding) and the guard must still reject it.
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    dnsResults.push(["93.184.216.43"], ["127.0.0.1"]);

    await fetchPublicUrl("https://rebind.test/first");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(fetchPublicUrl("https://rebind.test/second")).rejects.toBeInstanceOf(SsrfError);
    // Never dispatched — rejected before the cached dispatcher was reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
