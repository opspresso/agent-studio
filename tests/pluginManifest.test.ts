import { describe, expect, it } from "vitest";
import {
  classifyMcpJsonServer,
  isPluginName,
  MCP_JSON_SCHEMA,
  parseMcpJson,
  parsePluginManifest,
  parsePluginSource,
  PLUGIN_MANIFEST_SCHEMA,
} from "@/domain/plugin/types";

describe("isPluginName", () => {
  it.each([
    "devops",
    "a",
    "org.example.tools",
    "a-b.c-1",
    "a".repeat(64),
  ])("accepts %j", (name) => {
    expect(isPluginName(name)).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["a".repeat(65), "over 64 characters"],
    ["Devops", "uppercase"],
    ["-lead", "leading hyphen"],
    ["trail-", "trailing hyphen"],
    [".lead", "leading period"],
    ["trail.", "trailing period"],
    ["a--b", "consecutive hyphens"],
    ["a..b", "consecutive periods"],
    ["a b", "whitespace"],
    ["a_b", "underscore"],
  ])("rejects %j (%s)", (name) => {
    expect(isPluginName(name)).toBe(false);
  });
});

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA, name: "devops", ...overrides });
}

describe("parsePluginManifest", () => {
  it("reads the manifest fields it consumes", () => {
    const parsed = parsePluginManifest(
      manifest({
        version: "1.0.0",
        description: "DevOps bundle",
        author: { name: "opspresso", junk: "ignored" },
        homepage: "https://example.com",
        repository: "https://github.com/opspresso/agent-plugins",
        license: "MIT",
        keywords: ["devops", 42, "gitops"],
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      manifest: {
        name: "devops",
        version: "1.0.0",
        description: "DevOps bundle",
        author: { name: "opspresso", email: undefined, url: undefined },
        homepage: "https://example.com",
        repository: "https://github.com/opspresso/agent-plugins",
        license: "MIT",
        // Non-string keywords are dropped, not fatal.
        keywords: ["devops", "gitops"],
      },
    });
  });

  it("accepts the minimal manifest", () => {
    const parsed = parsePluginManifest(manifest());
    expect(parsed.ok).toBe(true);
  });

  it("tolerates unknown top-level fields — the spec requires it", () => {
    expect(parsePluginManifest(manifest({ somethingNew: { nested: true } })).ok).toBe(true);
  });

  it.each([
    ["not JSON at all", "{nope"],
    ["a JSON array", "[]"],
    ["a missing $schema", JSON.stringify({ name: "devops" })],
    ["a wrong $schema", manifest({ $schema: "https://example.com/other.json" })],
    ["a missing name", JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA })],
    ["an illegal name", manifest({ name: "Bad--Name" })],
  ])("refuses %s", (_case, raw) => {
    const parsed = parsePluginManifest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBeTruthy();
    }
  });
});

function mcpJson(servers: Record<string, unknown>): string {
  return JSON.stringify({ $schema: MCP_JSON_SCHEMA, mcpServers: servers });
}

describe("parseMcpJson", () => {
  it("returns the named server entries", () => {
    const parsed = parseMcpJson(
      mcpJson({ argocd: { type: "streamable-http", url: "https://x.test/mcp" } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.servers)).toEqual(["argocd"]);
    }
  });

  it.each([
    ["malformed JSON", "{nope"],
    ["a missing $schema", JSON.stringify({ mcpServers: {} })],
    ["a missing mcpServers object", JSON.stringify({ $schema: MCP_JSON_SCHEMA })],
    ["an array mcpServers", JSON.stringify({ $schema: MCP_JSON_SCHEMA, mcpServers: [] })],
  ])("refuses %s", (_case, raw) => {
    expect(parseMcpJson(raw).ok).toBe(false);
  });
});

describe("parsePluginSource", () => {
  it("reads the sync's provenance format back into its parts", () => {
    expect(parsePluginSource("github:opspresso/agent-plugins#devops")).toEqual({
      repo: "opspresso/agent-plugins",
      plugin: "devops",
    });
  });

  it("keeps a period-bearing plugin name whole", () => {
    expect(parsePluginSource("github:o/r#org.example.tools")).toEqual({
      repo: "o/r",
      plugin: "org.example.tools",
    });
  });

  it.each([
    ["the retired single-repo form", "github:opspresso/agent-skills"],
    ["a non-github source", "s3:bucket#plugin"],
    ["an empty repo", "github:#plugin"],
    ["an empty plugin", "github:o/r#"],
    ["an empty string", ""],
  ])("answers null for %s", (_case, source) => {
    expect(parsePluginSource(source)).toBeNull();
  });
});

describe("classifyMcpJsonServer", () => {
  it("accepts a streamable-http server and surfaces its declared header names", () => {
    expect(
      classifyMcpJsonServer({
        type: "streamable-http",
        url: "https://x.test/mcp",
        headers: { Authorization: "secret", "X-Tenant": "default" },
      }),
    ).toEqual({
      kind: "accepted",
      url: "https://x.test/mcp",
      declaredHeaderNames: ["Authorization", "X-Tenant"],
    });
  });

  it("accepts a server with no headers", () => {
    expect(classifyMcpJsonServer({ type: "streamable-http", url: "https://x.test/mcp" })).toEqual({
      kind: "accepted",
      url: "https://x.test/mcp",
      declaredHeaderNames: [],
    });
  });

  it.each(["stdio", "sse", "websocket-of-the-future"])(
    "classifies a %s server as an unsupported transport, never invalid",
    (type) => {
      expect(classifyMcpJsonServer({ type, command: "./run", url: "https://x.test" })).toEqual({
        kind: "unsupported-transport",
        transport: type,
      });
    },
  );

  it.each([
    ["a non-object entry", "nope"],
    ["a missing type", { url: "https://x.test/mcp" }],
    ["a streamable-http entry without a url", { type: "streamable-http" }],
  ])("marks %s invalid", (_case, entry) => {
    expect(classifyMcpJsonServer(entry).kind).toBe("invalid");
  });
});
