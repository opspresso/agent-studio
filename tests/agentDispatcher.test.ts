/**
 * The outbound transfer path (`RemoteAgentDispatcher.send`).
 *
 * A remote agent is the one dependency a run cannot inspect, so whatever it
 * answers with has to be turned into something the parent model can act on. The
 * failure that matters is the quiet one: an error status parsed as a reply with
 * no `choices` looks exactly like a transfer that succeeded and said nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// The SSRF boundary has its own tests; here it stands aside so the stubbed
// fetch is what the dispatcher talks to.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

const sendA2aMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, text: "a2a answer", images: [] })),
);
vi.mock("@/infrastructure/a2a/client", () => ({ sendA2aMessage: sendA2aMessageMock }));

import { remoteAgentDispatcher } from "@/infrastructure/agent/dispatcher";

const TARGET = { url: "https://agent.example.com/v1/chat/completions", headers: {} };

function stubFetch(body: string, init?: ResponseInit) {
  const fetchMock = vi.fn(async () => new Response(body, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  sendA2aMessageMock.mockClear();
});

describe("remoteAgentDispatcher.send", () => {
  it("returns the assistant text of a successful transfer", async () => {
    stubFetch(JSON.stringify({ choices: [{ message: { content: "from the child" } }] }));

    expect(await remoteAgentDispatcher.send(TARGET, "do the thing")).toEqual({
      ok: true,
      text: "from the child",
      images: [],
    });
  });

  it("reports an error status as a failed reply, not an empty successful one", async () => {
    stubFetch(JSON.stringify({ error: { message: "no credit" } }), { status: 402 });

    const reply = await remoteAgentDispatcher.send(TARGET, "do the thing");

    expect(reply.ok).toBe(false);
    // Both halves matter to the parent: an `ok` reply with "" reads as "the
    // agent answered nothing", which is a different thing from "it refused".
    expect(reply.ok === false && reply.error).toContain("HTTP 402");
    expect(reply.ok === false && reply.error).toContain("no credit");
  });

  it("reports a 2xx that is not JSON as a failed reply", async () => {
    // The shape a proxy interstitial arrives in: success status, HTML body.
    stubFetch("<!DOCTYPE html><title>Gateway</title>", {
      headers: { "Content-Type": "text/html" },
    });

    const reply = await remoteAgentDispatcher.send(TARGET, "do the thing");

    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.error).toContain("malformed reply");
    expect(reply.ok === false && reply.error).toContain("<!DOCTYPE html>");
  });

  it.each([
    ["missing choices", {}],
    ["empty choices", { choices: [] }],
    ["non-text content", { choices: [{ message: { content: [{ type: "text" }] } }] }],
  ])("reports %s as a failed reply", async (_name, body) => {
    stubFetch(JSON.stringify(body));

    const reply = await remoteAgentDispatcher.send(TARGET, "do the thing");

    expect(reply).toEqual({ ok: false, error: "No assistant message in response" });
  });

  it("refuses to buffer an oversized body", async () => {
    stubFetch("x".repeat(2_000_001));

    // Thrown rather than returned: `runRemoteSubagent` turns it into a tool
    // error for the parent, and nothing has buffered the body to get there.
    await expect(remoteAgentDispatcher.send(TARGET, "do the thing")).rejects.toThrow(
      /exceeds 2000000 bytes/,
    );
  });

  it("routes an a2a target to the a2a client", async () => {
    const fetchMock = stubFetch("{}");

    const reply = await remoteAgentDispatcher.send(
      { ...TARGET, protocol: "a2a" as const },
      "hello",
    );

    expect(reply).toEqual({ ok: true, text: "a2a answer", images: [] });
    expect(sendA2aMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
