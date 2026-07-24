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

import { fetchPublicUrl, PublicFetchError } from "@/infrastructure/net/publicFetch";
import { SsrfError } from "@/infrastructure/net/ssrfGuard";

afterEach(() => {
  vi.unstubAllGlobals();
  agentOptions.length = 0;
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
