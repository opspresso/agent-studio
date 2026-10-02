import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * The signer is the one piece of the Bedrock channel that is not the ordinary
 * OpenAI wire protocol, so it is tested directly: a wrong region or an unsigned
 * body reaches AWS as a 403 that names neither.
 *
 * Credentials are stubbed at the SDK provider, which is where the real ones
 * come from (Pod Identity in the cluster, the profile locally) — nothing here
 * touches AWS.
 */
vi.mock("@/infrastructure/llm/awsCredentials", () => ({
  awsCredentials: () => async () => ({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret-example",
  }),
}));

const { AWS_SIGNING_SERVICE, createSignedFetch } = await import("@/infrastructure/llm/awsSigner");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
});

/** The last request the stubbed global fetch was handed. */
function captureFetch(): { calls: Array<{ url: string; init: RequestInit; signal: AbortSignal; body: Buffer }> } {
  const captured = { calls: [] as Array<{ url: string; init: RequestInit; signal: AbortSignal; body: Buffer }> };
  vi.stubGlobal("fetch", async (input: URL | string | Request, init: RequestInit) => {
    const request = new Request(input, init);
    captured.calls.push({ url: request.url, init: { ...init, method: request.method, headers: request.headers }, signal: request.signal,
      body: Buffer.from(await request.arrayBuffer()) });
    return new Response("{}", { status: 200 });
  });
  return captured;
}

describe("createSignedFetch", () => {
  it("preserves a Request method, headers and cancellation", async () => {
    const captured = captureFetch();
    const caller = new AbortController();
    await createSignedFetch(AWS_SIGNING_SERVICE)(new Request("https://bedrock-mantle.us-east-1.api.aws/v1/models", {
      method: "HEAD", headers: { "x-probe": "request-header" }, signal: caller.signal,
    }));
    expect(captured.calls[0]?.init.method).toBe("HEAD");
    expect(captured.calls[0]?.init.redirect).toBe("error");
    expect(new Headers(captured.calls[0]?.init.headers).get("x-probe")).toBe("request-header");
    caller.abort();
    expect(captured.calls[0]?.signal.aborted).toBe(true);
  });

  it("refuses a Request body that cannot be signed without draining it", async () => {
    const captured = captureFetch();
    await expect(createSignedFetch(AWS_SIGNING_SERVICE)(new Request("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions", {
      method: "POST", body: "{}",
    }))).rejects.toThrow(/cannot sign a ReadableStream body/);
    expect(captured.calls).toHaveLength(0);
  });

  it("signs common HTTP methods after fetch normalization", async () => {
    const captured = captureFetch();
    const signedFetch = createSignedFetch(AWS_SIGNING_SERVICE);
    const url = "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions";
    await signedFetch(url, { method: "post", body: "{}" });
    await signedFetch(url, { method: "POST", body: "{}" });
    expect(new Headers(captured.calls[0]?.init.headers).get("authorization"))
      .toBe(new Headers(captured.calls[1]?.init.headers).get("authorization"));
  });

  it("signs the transmitted bytes when the caller changes its buffer while credentials resolve", async () => {
    const captured = captureFetch();
    const body = new Uint8Array([1, 2, 3]);
    const sending = createSignedFetch(AWS_SIGNING_SERVICE)("https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions", {
      method: "POST", body,
    });
    body.fill(9);
    await sending;
    const sent = captured.calls[0]!;
    expect([...sent.body]).toEqual([1, 2, 3]);
    expect(new Headers(sent.init.headers).get("x-amz-content-sha256"))
      .toBe(createHash("sha256").update(sent.body).digest("hex"));
  });

  it("includes prototype-named query parameters in the signature", async () => {
    const captured = captureFetch();
    const signedFetch = createSignedFetch(AWS_SIGNING_SERVICE);
    const base = "https://bedrock-mantle.us-east-1.api.aws/v1/models";
    await signedFetch(`${base}?__proto__=one`);
    await signedFetch(`${base}?__proto__=two`);
    expect(new Headers(captured.calls[0]?.init.headers).get("authorization"))
      .not.toBe(new Headers(captured.calls[1]?.init.headers).get("authorization"));
  });

  it("signs with the region named by the host, not the app's region", async () => {
    const captured = captureFetch();
    const signedFetch = createSignedFetch(AWS_SIGNING_SERVICE);

    await signedFetch("https://bedrock-mantle.ap-northeast-1.api.aws/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai.gpt-oss-120b", messages: [] }),
    });

    const headers = new Headers(captured.calls[0]?.init.headers);
    const authorization = headers.get("authorization") ?? "";
    const amzDate = headers.get("x-amz-date") ?? "";
    // Read the scope's date off the request rather than the clock, so the
    // assertion cannot straddle a UTC midnight.
    const day = amzDate.slice(0, 8);
    expect(authorization).toContain(
      `Credential=AKIAEXAMPLE/${day}/ap-northeast-1/bedrock/aws4_request`,
    );
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(headers.get("host")).toBe("bedrock-mantle.ap-northeast-1.api.aws");
  });

  it("signs over the body, so the same request with different bytes signs differently", async () => {
    const captured = captureFetch();
    const signedFetch = createSignedFetch(AWS_SIGNING_SERVICE);
    const url = "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions";

    await signedFetch(url, { method: "POST", body: '{"a":1}' });
    await signedFetch(url, { method: "POST", body: '{"a":2}' });

    const first = new Headers(captured.calls[0]?.init.headers).get("authorization");
    const second = new Headers(captured.calls[1]?.init.headers).get("authorization");
    expect(first).not.toBe(second);
  });

  it("refuses a body it cannot sign instead of sending it unsigned", async () => {
    captureFetch();
    const signedFetch = createSignedFetch(AWS_SIGNING_SERVICE);

    await expect(
      signedFetch("https://bedrock-mantle.us-east-1.api.aws/v1/images/edits", {
        method: "POST",
        body: new FormData(),
      }),
    ).rejects.toThrow(/cannot sign a FormData body/);
  });

  it("refuses a host that names no region", async () => {
    captureFetch();
    const signedFetch = createSignedFetch(AWS_SIGNING_SERVICE);

    await expect(
      signedFetch("https://bedrock-mantle.api.aws/v1/chat/completions", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow(/names no region/);
  });
});
