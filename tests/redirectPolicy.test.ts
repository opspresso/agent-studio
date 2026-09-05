import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSameOrigin, MAX_OUTBOUND_REDIRECTS } from "@/infrastructure/net/redirectPolicy";
import { McpSession } from "@/infrastructure/mcp/session";
import { modernResult, protocolPreamble } from "./mcpProtocolStub";

const URL = "http://127.0.0.1:3001/mcp";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("same-origin redirect policy", () => {
  it.each([
    [301, "POST", "GET"],
    [302, "POST", "GET"],
    [303, "POST", "GET"],
    [303, "PUT", "GET"],
    [303, "GET", "GET"],
    [303, "HEAD", "HEAD"],
    [301, "PUT", "PUT"],
    [302, "PATCH", "PATCH"],
    [307, "POST", "POST"],
    [308, "POST", "POST"],
  ])("follows %i from %s as %s", async (status, method, redirectedMethod) => {
    const cancel = vi.fn();
    const direct = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
        status,
        headers: { location: "/moved" },
      }))
      .mockResolvedValueOnce(new Response("done"));
    vi.stubGlobal("fetch", direct);
    const signal = new AbortController().signal;
    const body = method === "GET" || method === "HEAD" ? undefined : "payload";

    const response = await fetchSameOrigin(URL, {
      method,
      body,
      signal,
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "text/plain",
        "Content-Length": "7",
        "Content-Encoding": "identity",
        "Content-Language": "en",
        "Content-Location": "/payload",
      },
    });

    expect(response.url).toBe("http://127.0.0.1:3001/moved");
    expect(await response.text()).toBe("done");
    expect(cancel).toHaveBeenCalledOnce();
    const next = direct.mock.calls[1]![1] as RequestInit;
    expect(next.method).toBe(redirectedMethod);
    expect(next.signal).toBe(signal);
    expect(next.redirect).toBe("manual");
    expect(direct.mock.calls[0]![1].redirect).toBe("manual");
    expect(next.body).toBe(method === redirectedMethod ? body : undefined);
    const headers = new Headers(next.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) {
      expect(headers.has(name)).toBe(method === redirectedMethod);
    }
  });

  it("replays a Request's body and headers through 307 and keeps its cancellation", async () => {
    const controller = new AbortController();
    const bodies: string[] = [];
    const signals: AbortSignal[] = [];
    const direct = vi.fn(async (_url, init: RequestInit) => {
      bodies.push(await new Response(init.body).text());
      signals.push(init.signal!);
      expect(new Headers(init.headers).get("x-token")).toBe("secret");
      return bodies.length === 1
        ? new Response(null, { status: 307, headers: { location: "/moved" } })
        : new Response("done");
    });
    vi.stubGlobal("fetch", direct);
    const request = new Request(URL, {
      method: "POST", body: "request body", headers: { "X-Token": "secret" }, signal: controller.signal,
    });

    await fetchSameOrigin(request);

    expect(bodies).toEqual(["request body", "request body"]);
    controller.abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("applies init overrides to Request input before following", async () => {
    const direct = vi.fn().mockResolvedValue(new Response("done"));
    vi.stubGlobal("fetch", direct);
    const request = new Request(URL, { method: "POST", body: "old", headers: { "X-Old": "old" } });
    const controller = new AbortController();

    await fetchSameOrigin(request, {
      method: "PUT", body: "new", headers: { "X-New": "new" }, signal: controller.signal,
    });

    const sent = direct.mock.calls[0]![1] as RequestInit;
    expect(sent.method).toBe("PUT");
    expect(await new Response(sent.body).text()).toBe("new");
    expect(new Headers(sent.headers).get("x-old")).toBeNull();
    expect(new Headers(sent.headers).get("x-new")).toBe("new");
    controller.abort();
    expect(sent.signal?.aborted).toBe(true);
  });

  it.each(["http://127.0.0.1:3002/mcp", "https://127.0.0.1:3001/mcp", "http://other.internal/mcp"])(
    "refuses a redirect to %s and cancels its body",
    async (location) => {
      const cancel = vi.fn();
      const direct = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
        status: 307, headers: { location },
      }));
      vi.stubGlobal("fetch", direct);

      await expect(fetchSameOrigin(URL, { headers: { "X-Token": "secret" } }))
        .rejects.toThrow("Cross-origin redirect blocked");

      expect(direct).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("cancels every redirect body, including the one past the cap", async () => {
    const cancel = vi.fn();
    const direct = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      status: 308, headers: { location: "/again" },
    }));
    vi.stubGlobal("fetch", direct);

    await expect(fetchSameOrigin(URL)).rejects.toThrow("Too many redirects");

    expect(direct).toHaveBeenCalledTimes(MAX_OUTBOUND_REDIRECTS + 1);
    expect(cancel).toHaveBeenCalledTimes(MAX_OUTBOUND_REDIRECTS + 1);
  });

  it("cancels before rejecting a malformed Location", async () => {
    const cancel = vi.fn();
    const direct = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { location: "http://[" },
    }));
    vi.stubGlobal("fetch", direct);

    await expect(fetchSameOrigin(URL)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(direct).toHaveBeenCalledOnce();
  });

  it("returns a redirect without Location with its readable body and final URL", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 302 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await fetchSameOrigin(URL);

    expect(result).toBe(response);
    expect(result.url).toBe(URL);
    expect(cancel).not.toHaveBeenCalled();
    await result.body?.cancel();
  });

  it("stops before the next hop when the request signal is aborted", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const direct = vi.fn(async () => {
      controller.abort(new Error("run cancelled"));
      return new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: "/next" } });
    });
    vi.stubGlobal("fetch", direct);

    await expect(fetchSameOrigin(URL, { signal: controller.signal })).rejects.toThrow("run cancelled");
    expect(direct).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("MCP internal transport redirects", () => {
  it("applies the policy to the SDK probe and tool requests", async () => {
    const seen: string[] = [];
    const direct = vi.fn(async (input, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("x-token")).toBe("secret");
      if (String(input) === URL) {
        return new Response(null, { status: 307, headers: { location: "/moved" } });
      }
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      seen.push(body.method);
      return protocolPreamble(body.method, body.id, init?.method) ?? new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: modernResult(body.method, body.method === "tools/call"
          ? { content: [{ type: "text", text: "done" }] }
          : { tools: [] }),
      }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", direct);
    const session = new McpSession(URL, { "X-Token": "secret" }, undefined, true);
    try {
      expect((await session.listTools()).tools).toEqual([]);
      expect(await session.callTool("search", {})).toMatchObject({
        content: [{ type: "text", text: "done" }],
      });
      expect(seen).toEqual(["server/discover", "tools/list", "tools/call"]);
    } finally {
      await session.end();
    }
  });

  it("never follows an internal server's credential-bearing redirect off origin", async () => {
    const cancel = vi.fn();
    const direct = vi.fn(async (_input, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(new ReadableStream({ cancel }), {
        status: 307, headers: { location: "http://other.internal/steal" },
      });
    });
    vi.stubGlobal("fetch", direct);
    const session = new McpSession(URL, { "X-Token": "secret" }, undefined, true);
    try {
      await expect(session.listTools()).rejects.toThrow();
      expect(direct.mock.calls.every(([input]) => String(input) === URL)).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(direct.mock.calls.length);
    } finally {
      await session.end();
    }
  });
});
