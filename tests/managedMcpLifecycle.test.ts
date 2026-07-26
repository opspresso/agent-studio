import { describe, expect, it } from "vitest";
import { createManagedMcpUseCases } from "@/application/mcp/managedMcpUseCases";
import type { McpServer } from "@/domain/mcp/types";
import type { ManagedWorkload, McpProvisioner } from "@/domain/mcp/provisioner";

function fixture(opts: { address?: string; existing?: McpServer } = {}) {
  const rows = new Map<string, McpServer>();
  if (opts.existing) {
    rows.set(opts.existing.name, opts.existing);
  }
  const stopped: string[] = [];
  const started: string[] = [];
  const provisioner: McpProvisioner = {
    async start(spec) {
      started.push(spec.name);
      return {
        name: spec.name,
        address: opts.address ?? "http://127.0.0.1:3001",
        identity: "container-1",
        running: true,
      } satisfies ManagedWorkload;
    },
    async stop(name) {
      stopped.push(name);
    },
    async inspect(name) {
      return rows.has(name)
        ? { name, address: "http://127.0.0.1:3001", identity: "container-1", running: true }
        : null;
    },
  };
  const repo = {
    get: async (name: string) => rows.get(name) ?? null,
    list: async () => [...rows.values()],
    create: async (server: McpServer) => {
      rows.set(server.name, server);
    },
    update: async (server: McpServer) => {
      rows.set(server.name, server);
    },
    put: async (server: McpServer) => {
      rows.set(server.name, server);
    },
    delete: async (name: string) => {
      rows.delete(name);
    },
  };
  const invalidated: string[] = [];
  const useCases = createManagedMcpUseCases({
    repo: repo as never,
    provisioner,
    probe: { invalidateDiscovery: (url: string) => invalidated.push(url) } as never,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { useCases, rows, stopped, started, invalidated };
}

const input = { name: "image-fetch", image: "ecr/img:v1", containerPort: 3001 };

describe("managed MCP lifecycle", () => {
  it("stores the address the provisioner reported", async () => {
    const { useCases, rows } = fixture();
    const server = await useCases.create(input);

    expect(server.runtime).toBe("managed");
    expect(server.url).toBe("http://127.0.0.1:3001/mcp");
    expect(rows.get("image-fetch")?.image).toBe("ecr/img:v1");
  });

  it("refuses to register an address that is not loopback, and stops what it started", async () => {
    // The provisioner is the only source of this value, but not the only thing
    // that has to agree it is safe: a stored entry carries a guard bypass.
    const { useCases, rows, stopped } = fixture({ address: "http://10.0.0.7:3001" });

    await expect(useCases.create(input)).rejects.toThrow(/loopback/);
    expect(rows.has("image-fetch")).toBe(false);
    // and nothing is left running behind a row that was never written
    expect(stopped).toEqual(["image-fetch"]);
  });

  it("removes the container before the entry that points at it", async () => {
    const { useCases, rows, stopped, invalidated } = fixture();
    await useCases.create(input);
    await useCases.remove("image-fetch");

    expect(stopped).toEqual(["image-fetch"]);
    expect(rows.has("image-fetch")).toBe(false);
    expect(invalidated).toEqual(["http://127.0.0.1:3001/mcp"]);
  });

  it("will not touch a remote server through the managed path", async () => {
    const remote: McpServer = {
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { useCases, rows } = fixture({ existing: remote });

    await expect(useCases.remove("github")).rejects.toThrow(/not managed/);
    expect(rows.has("github")).toBe(true);
  });

  it("refuses a name that is already taken", async () => {
    const taken: McpServer = {
      name: "image-fetch",
      url: "https://example.test/mcp",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { useCases, started } = fixture({ existing: taken });
    await expect(useCases.create(input)).rejects.toThrow(/already exists/);
    // nothing was started for a name that could not be registered
    expect(started).toEqual([]);
  });
});
