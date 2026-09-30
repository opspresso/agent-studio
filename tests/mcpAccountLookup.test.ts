import { describe, expect, it } from "vitest";
import { accountLabelAt, readMcpAccountLookup, resolveMcpAccountLookup } from "@/domain/mcp/account";
import type { McpServerAuth } from "@/domain/mcp/types";

describe("extensible account lookup contracts", () => {
  it.each([
    { kind: "http", endpoint: "http://identity.example.test/me", labelPath: "/email" },
    { kind: "http", endpoint: "https://secret@identity.example.test/me", labelPath: "/email" },
    { kind: "http", endpoint: "https://identity.example.test/me#fragment", labelPath: "/email" },
    { kind: "http", endpoint: "https://identity.example.test/me", labelPath: "$.email" },
    { kind: "http", endpoint: "https://identity.example.test/me", labelPath: "/bad~escape" },
    { kind: "http", endpoint: "https://identity.example.test/me", labelPath: "/email", method: "POST" },
    { kind: "mcp", toolName: "whoami", arguments: [], labelPath: "/email" },
    { kind: "mcp", toolName: "whoami", arguments: { padding: "x".repeat(4_096) }, labelPath: "/email" },
    { kind: "none", endpoint: "https://identity.example.test/me" },
    { kind: "http", endpoint: "https://identity.example.test/me", labelPath: "/data/access_token" },
    { kind: "mcp", toolName: "whoami", arguments: { credentials: { apiKey: "must-not-be-stored" } }, labelPath: "/email" },
  ])("rejects malformed or unsafe operator contracts %j", value => {
    expect(readMcpAccountLookup(value)).toBeUndefined();
  });

  it("does not select inherited properties or execute expressions", () => {
    expect(accountLabelAt(Object.create({ email: "wrong@example.test" }), "/email")).toBeUndefined();
    expect(accountLabelAt({ account: { email: "actual@example.test" } }, "/account/email")).toBe("actual@example.test");
    expect(accountLabelAt({}, "/constructor/prototype")).toBeUndefined();
  });

  it("restores automatic discovery by removing an override", () => {
    const auth: McpServerAuth = {
      type: "oauth2", issuer: "https://new.example.test", authorizationServer: "https://new.example.test",
      authorizationEndpoint: "https://new.example.test/authorize", tokenEndpoint: "https://new.example.test/token",
      resource: "https://new-mcp.example.test", tokenEndpointAuthMethod: "none", discoveredAt: "2026-09-30T00:00:00.000Z",
      userInfoEndpoint: "https://new.example.test/userinfo", accountLookup: { kind: "none" },
    };
    expect(resolveMcpAccountLookup(auth)).toBeUndefined();
    expect(resolveMcpAccountLookup({ ...auth, accountLookup: undefined })?.provider).toBe("oidc");
  });
});
