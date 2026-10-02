/**
 * The Client ID Metadata Document this deployment publishes for the installation.
 *
 * What it has to get right is narrow and unforgiving: the `client_id` inside the
 * document must equal the URL it was fetched from, or every authorization
 * against a server that resolves it is rejected — and the reader is an
 * authorization server, so the route must answer without a session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publicBaseUrl } = vi.hoisted(() => ({
  publicBaseUrl: { value: "https://studio.example.com" as string | undefined },
}));

vi.mock("@/lib/runtime-settings", () => ({
  getPublicBaseUrl: async () => publicBaseUrl.value,
  getServiceBranding: async () => ({ name: process.env.SERVICE_NAME || "Agent Studio" }),
}));

import { GET } from "@/app/api/mcps/oauth/client-metadata/route";
import { clientMetadataUrl, MCP_OAUTH_CALLBACK_PATH } from "@/application/mcp/mcpAuthUseCases";


beforeEach(() => {
  publicBaseUrl.value = "https://studio.example.com";
});
afterEach(() => vi.unstubAllEnvs());

describe("the installation client ID metadata document", () => {
  it("states a client_id equal to the URL it is served at", async () => {
    const response = await GET();
    const document = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    // The rule the whole mechanism rests on. Built from the configured base by
    // the same function the authorization flow uses, so the two cannot drift.
    expect(document.client_id).toBe("https://studio.example.com/api/mcps/oauth/client-metadata");
    expect(document.client_id).toBe(clientMetadataUrl("https://studio.example.com"));
  });

  it("carries the three required fields, and this deployment's callback", async () => {
    const document = (await (await GET()).json()) as Record<string, unknown>;

    expect(document.client_name).toBe("Agent Studio");
    expect(document.redirect_uris).toEqual([
      `https://studio.example.com${MCP_OAUTH_CALLBACK_PATH}`,
    ]);
    // Public by construction: a self-hosted client_id has no secret to prove.
    expect(document.token_endpoint_auth_method).toBe("none");
  });

  it("uses the configured service name without changing the client ID", async () => {
    vi.stubEnv("SERVICE_NAME", "AgentOps");
    const document = (await (await GET()).json()) as Record<string, unknown>;
    expect(document.client_name).toBe("AgentOps");
    expect(document.client_id).toBe(clientMetadataUrl("https://studio.example.com"));
  });

  it("answers without a session, because the reader is an authorization server", async () => {
    // Not an oversight to be tightened later: the fetch comes from wherever the
    // provider runs, with no cookie, and a 401 here fails every authorization
    // with nothing to say why.
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it("refuses to guess an address when none is configured", async () => {
    // Deriving one from the request would publish a document authorizing a
    // redirect to whichever host asked for it.
    publicBaseUrl.value = undefined;

    expect((await GET()).status).toBe(503);
  });

  it("lets a server cache it, but briefly", async () => {
    // The document changes when this deployment's own address does, and an
    // authorization server holding a stale `redirect_uri` refuses every
    // authorization until its copy expires. Asserted because the cost of the
    // number growing is paid by whoever moves the deployment, long after.
    const response = await GET();

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("tolerates a base URL with a trailing slash", async () => {
    publicBaseUrl.value = "https://studio.example.com/";
    const document = (await (await GET()).json()) as Record<string, unknown>;

    expect(document.client_id).toBe(
      "https://studio.example.com/api/mcps/oauth/client-metadata",
    );
  });
});
