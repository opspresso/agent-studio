/**
 * Which outbound path a metadata read takes, and what a failed read is.
 *
 * "May this address be dialed" has one owner (`skipsUrlGuard`), and every other
 * caller — a run, the tool probe — carries its answer through. Discovery used to
 * reach for the guard directly instead, so a Kubernetes Service this deployment
 * declared internal could be registered and called by an agent, and never
 * discovered.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const guardedFetch = vi.fn();

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => guardedFetch(input, init),
}));

import { McpMetadataError } from "@/domain/mcp/oauth";
import { oauthMetadataClient } from "@/infrastructure/mcp/oauthMetadata";

const INTERNAL_URL = "http://mcp-memory.agent-mcps.svc.cluster.local/mcp";
const RESOURCE_DOC = {
  resource: "http://mcp-memory.agent-mcps.svc.cluster.local",
  authorization_servers: ["https://auth.example.com"],
};
const AS_DOC = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  guardedFetch.mockReset();
});

describe("reading protected resource metadata", () => {
  it("dials a declared-internal host directly, the way a run already does", async () => {
    const direct = vi.fn(async () => jsonResponse(RESOURCE_DOC));
    vi.stubGlobal("fetch", direct);

    const result = await oauthMetadataClient.fetchProtectedResource(INTERNAL_URL, true);

    expect(result.resource).toBe(RESOURCE_DOC.resource);
    expect(direct).toHaveBeenCalled();
    // The whole point: the guard would reject this address on every request.
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("keeps the guard for a host nobody declared internal", async () => {
    const direct = vi.fn();
    vi.stubGlobal("fetch", direct);
    guardedFetch.mockResolvedValue(jsonResponse(RESOURCE_DOC));

    await oauthMetadataClient.fetchProtectedResource("https://mcp.example.com/mcp");

    expect(guardedFetch).toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("defaults to the guarded path when the caller says nothing", async () => {
    const direct = vi.fn();
    vi.stubGlobal("fetch", direct);
    guardedFetch.mockResolvedValue(jsonResponse(RESOURCE_DOC));

    await oauthMetadataClient.fetchProtectedResource(INTERNAL_URL);

    // Forgetting the flag must cost tools, never protection.
    expect(guardedFetch).toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("reports a refusal as a metadata failure, naming every candidate it tried", async () => {
    guardedFetch.mockRejectedValue(
      new Error("URL host resolves to a private or reserved address: mcp-memory.agent-mcps.svc.cluster.local"),
    );

    const error = await oauthMetadataClient
      .fetchProtectedResource(INTERNAL_URL)
      .catch((caught: unknown) => caught);

    // Typed, so the caller can give it a status. As a bare Error this reached a
    // route with nothing to map and answered 500.
    expect(error).toBeInstanceOf(McpMetadataError);
    expect((error as Error).message).toContain("private or reserved address");
    expect((error as Error).message).toContain("/.well-known/oauth-protected-resource/mcp");
    expect((error as Error).message).toContain("/.well-known/oauth-protected-resource:");
  });

  it("is a metadata failure when the server answers, but with nothing usable", async () => {
    // RFC 9728 requires both fields; a document missing one cannot drive an
    // authorization, and saying so is not the same as crashing.
    guardedFetch.mockResolvedValue(jsonResponse({ resource: "https://mcp.example.com" }));

    await expect(
      oauthMetadataClient.fetchProtectedResource("https://mcp.example.com/mcp"),
    ).rejects.toBeInstanceOf(McpMetadataError);
  });
});

describe("reading authorization server metadata", () => {
  it("never takes the direct path, whatever the resource was", async () => {
    const direct = vi.fn();
    vi.stubGlobal("fetch", direct);
    guardedFetch.mockResolvedValue(jsonResponse(AS_DOC));

    await oauthMetadataClient.fetchAuthorizationServer("https://auth.example.com");

    // This URL came out of a third party's document, not the registry. An
    // operator declaring a host internal says nothing about an authorization
    // server that host names for itself.
    expect(guardedFetch).toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });
});

/**
 * What the adapter reads *out* of an authorization server's document.
 *
 * Untested until now, and it is the seam that decides how a project gets an
 * OAuth client: `client_id_metadata_document_supported` and
 * `registration_endpoint` are what `beginAuthorization` branches on, and both
 * are spelled in exactly one place. Every test above this stubs the port rather
 * than the wire, so a misspelling here would take the whole branch out — a
 * document route that never engages, or a registration fallback that never
 * does — with nothing failing to say so.
 *
 * The document below is the shape Notion actually publishes, which is the case
 * that turned this up: it offers both routes.
 */
describe("what an authorization server's document says", () => {
  const NOTION_DOC = {
    issuer: "https://mcp.notion.com",
    authorization_endpoint: "https://mcp.notion.com/authorize",
    token_endpoint: "https://mcp.notion.com/token",
    registration_endpoint: "https://mcp.notion.com/register",
    scopes_supported: ["default"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["plain", "S256"],
    client_id_metadata_document_supported: true,
  };

  it("reads both ways of getting a client", async () => {
    guardedFetch.mockResolvedValue(jsonResponse(NOTION_DOC));

    const metadata = await oauthMetadataClient.fetchAuthorizationServer(
      "https://mcp.notion.com",
    );

    expect(metadata).toMatchObject({
      issuer: "https://mcp.notion.com",
      authorizationEndpoint: "https://mcp.notion.com/authorize",
      tokenEndpoint: "https://mcp.notion.com/token",
      registrationEndpoint: "https://mcp.notion.com/register",
      clientIdMetadataDocumentSupported: true,
      scopesSupported: ["default"],
      codeChallengeMethodsSupported: ["plain", "S256"],
    });
  });

  it("leaves both absent when the server offers neither", async () => {
    // Absent rather than `false`: the branch reads truthiness, and a stored
    // `false` would be a claim the document never made.
    guardedFetch.mockResolvedValue(jsonResponse(AS_DOC));

    const metadata = await oauthMetadataClient.fetchAuthorizationServer(
      "https://auth.example.com",
    );

    expect(metadata.registrationEndpoint).toBeUndefined();
    expect(metadata.clientIdMetadataDocumentSupported).toBeUndefined();
  });

  it("takes only an explicit true for document support", async () => {
    // A server answering with the string "true", or with an object, has not
    // said yes — and reading it as yes sends every connection down a route the
    // server will refuse.
    guardedFetch.mockResolvedValue(
      jsonResponse({ ...AS_DOC, client_id_metadata_document_supported: "true" }),
    );

    const metadata = await oauthMetadataClient.fetchAuthorizationServer(
      "https://auth.example.com",
    );

    expect(metadata.clientIdMetadataDocumentSupported).toBeUndefined();
  });
});
