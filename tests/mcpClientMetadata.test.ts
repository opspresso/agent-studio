/**
 * The Client ID Metadata Document this deployment publishes per project.
 *
 * What it has to get right is narrow and unforgiving: the `client_id` inside the
 * document must equal the URL it was fetched from, or every authorization
 * against a server that resolves it is rejected — and the reader is an
 * authorization server, so the route must answer without a session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { publicBaseUrl } = vi.hoisted(() => ({
  publicBaseUrl: { value: "https://studio.example.com" as string | undefined },
}));

vi.mock("@/lib/runtime-settings", () => ({
  getPublicBaseUrl: async () => publicBaseUrl.value,
}));

import { GET } from "@/app/api/mcps/oauth/client-metadata/[project]/route";
import { clientMetadataUrl, MCP_OAUTH_CALLBACK_PATH } from "@/application/mcp/mcpAuthUseCases";

function get(project: string): Promise<Response> {
  return GET(new Request("https://whatever.example/ignored"), {
    params: Promise.resolve({ project }),
  });
}

beforeEach(() => {
  publicBaseUrl.value = "https://studio.example.com";
});

describe("a project's client ID metadata document", () => {
  it("states a client_id equal to the URL it is served at", async () => {
    const response = await get("helper");
    const document = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    // The rule the whole mechanism rests on. Built from the configured base by
    // the same function the authorization flow uses, so the two cannot drift.
    expect(document.client_id).toBe("https://studio.example.com/api/mcps/oauth/client-metadata/helper");
    expect(document.client_id).toBe(clientMetadataUrl("https://studio.example.com", "helper"));
  });

  it("carries the three required fields, and this deployment's callback", async () => {
    const document = (await (await get("helper")).json()) as Record<string, unknown>;

    expect(document.client_name).toBe("AgentDure — helper");
    expect(document.redirect_uris).toEqual([
      `https://studio.example.com${MCP_OAUTH_CALLBACK_PATH}`,
    ]);
    // Public by construction: a self-hosted client_id has no secret to prove.
    expect(document.token_endpoint_auth_method).toBe("none");
  });

  it("names the project, so a person approving the connection can tell which is asking", async () => {
    const first = (await (await get("alpha")).json()) as Record<string, unknown>;
    const second = (await (await get("beta")).json()) as Record<string, unknown>;

    expect(first.client_id).not.toBe(second.client_id);
    expect(first.client_name).toBe("AgentDure — alpha");
    expect(second.client_name).toBe("AgentDure — beta");
  });

  it("answers without a session, because the reader is an authorization server", async () => {
    // Not an oversight to be tightened later: the fetch comes from wherever the
    // provider runs, with no cookie, and a 401 here fails every authorization
    // with nothing to say why.
    const response = await get("helper");
    expect(response.status).toBe(200);
  });

  it("refuses a name that could not have been a project", async () => {
    expect((await get("../../etc/passwd")).status).toBe(404);
    expect((await get("Not A Slug")).status).toBe(404);
  });

  it("refuses to guess an address when none is configured", async () => {
    // Deriving one from the request would publish a document authorizing a
    // redirect to whichever host asked for it.
    publicBaseUrl.value = undefined;

    expect((await get("helper")).status).toBe(503);
  });

  it("tolerates a base URL with a trailing slash", async () => {
    publicBaseUrl.value = "https://studio.example.com/";
    const document = (await (await get("helper")).json()) as Record<string, unknown>;

    expect(document.client_id).toBe(
      "https://studio.example.com/api/mcps/oauth/client-metadata/helper",
    );
  });
});
