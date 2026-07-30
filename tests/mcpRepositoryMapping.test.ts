import { describe, expect, it, vi } from "vitest";

let stored: Record<string, unknown> = {};

/** Records what was written and answers reads from it. */
const fakeClient = {
  async send(command: { input: Record<string, unknown>; constructor: { name: string } }) {
    const name = command.constructor.name;
    if (name === "PutCommand") {
      stored = command.input.Item as Record<string, unknown>;
      return {};
    }
    if (name === "GetCommand") {
      return { Item: stored };
    }
    return {};
  },
};

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { mcpRepository } = await import("@/infrastructure/db/repositories/mcpRepository");
import type { McpServer } from "@/domain/mcp/types";

/**
 * The mapper names its fields one by one, so a field added to the entity is
 * simply dropped until it is added here too — silently, which for `runtime`
 * means a managed entry reads back as remote and loses the only thing that
 * makes its address reachable.
 */
describe("mcp repository mapping", () => {
  it("round-trips the fields a managed entry depends on", async () => {
    const server: McpServer = {
      name: "image-fetch",
      runtime: "managed",
      url: "http://127.0.0.1:3204/mcp",
      image: "mcp-image-fetch:local",
      envRefs: ["/env/prod/mcp-image-fetch"],
      environment: { API_TOKEN: "enc:v1:ciphertext" },
      args: ["--transport", "streamable-http"],
      endpointPath: "/custom-mcp",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await mcpRepository.put(server);

    expect(stored.runtime).toBe("managed");
    expect(stored.image).toBe("mcp-image-fetch:local");
    expect(stored.envRefs).toEqual(["/env/prod/mcp-image-fetch"]);
    expect(stored.environment).toEqual({ API_TOKEN: "enc:v1:ciphertext" });
    expect(stored.args).toEqual(["--transport", "streamable-http"]);
    expect(stored.endpointPath).toBe("/custom-mcp");

    const read = await mcpRepository.get("image-fetch");
    expect(read?.runtime).toBe("managed");
    expect(read?.image).toBe("mcp-image-fetch:local");
    expect(read?.args).toEqual(["--transport", "streamable-http"]);
    expect(read?.environment).toEqual({ API_TOKEN: "enc:v1:ciphertext" });
    expect(read?.endpointPath).toBe("/custom-mcp");
    expect(read?.url).toBe("http://127.0.0.1:3204/mcp");
  });

  it("reads a row written before managed servers existed as remote", async () => {
    stored = {
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const read = await mcpRepository.get("github");
    expect(read?.runtime).toBeUndefined();
  });
});
