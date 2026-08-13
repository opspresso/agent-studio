import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The signer is the one piece of the Bedrock channel that is not the ordinary
 * OpenAI wire protocol, so it is tested directly: a wrong region or an unsigned
 * body reaches AWS as a 403 that names neither.
 *
 * Credentials are stubbed at the Bedrock client, which is where the real ones
 * come from (Pod Identity in the cluster, the profile locally) — nothing here
 * touches AWS.
 */
vi.mock("@/infrastructure/llm/bedrockClient", () => ({
  bedrockRuntime: () => ({
    config: {
      credentials: async () => ({
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret-example",
      }),
    },
  }),
}));

const { AWS_SIGNING_SERVICE, createSignedFetch } = await import("@/infrastructure/llm/awsSigner");

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The last request the stubbed global fetch was handed. */
function captureFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
  const captured = { calls: [] as Array<{ url: string; init: RequestInit }> };
  vi.stubGlobal("fetch", async (url: URL | string, init: RequestInit) => {
    captured.calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  });
  return captured;
}

describe("createSignedFetch", () => {
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
