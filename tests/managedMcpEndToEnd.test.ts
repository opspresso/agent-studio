// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createManagedMcpUseCases } from "@/application/mcp/managedMcpUseCases";
import { buildMcpTools } from "@/application/execution/mcpTools";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import type { McpServer } from "@/domain/mcp/types";
import type { McpProvisioner } from "@/domain/mcp/provisioner";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { Version } from "@/domain/project/types";

/**
 * The whole path, against a server actually listening on loopback: provision,
 * register, then reach it through the run's own dispatch — with a URL policy
 * that refuses everything, standing in for the real guard.
 *
 * `publicFetch` is deliberately NOT mocked here. A managed session must take
 * the unguarded path on its own; if it did not, this test would fail the way
 * production would.
 */

function startLoopbackMcp(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body || "{}") as { id?: number; method?: string };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "tools/list"
          ? { tools: [{ name: "fetch_image", description: "d", inputSchema: { type: "object" } }] }
          : { protocolVersion: "2025-06-18", serverInfo: { name: "loopback-mcp" } };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

describe("managed MCP, end to end on loopback", () => {
  it("provisions, registers, and is reachable by a run", async () => {
    clearMcpDiscoveryCache();
    const { server, port } = await startLoopbackMcp();
    const rows = new Map<string, McpServer>();

    const provisioner: McpProvisioner = {
      async start(spec) {
        return {
          name: spec.name,
          address: `http://127.0.0.1:${port}`,
          identity: "container-1",
          running: true,
        };
      },
      async stop() {},
      async inspect(name) {
        return rows.has(name)
          ? { name, address: `http://127.0.0.1:${port}`, identity: "container-1", running: true }
          : null;
      },
    };
    const repo = {
      get: async (name: string) => rows.get(name) ?? null,
      list: async () => [...rows.values()],
      create: async (s: McpServer) => void rows.set(s.name, s),
      update: async (s: McpServer) => void rows.set(s.name, s),
      put: async (s: McpServer) => void rows.set(s.name, s),
      delete: async (name: string) => void rows.delete(name),
    };

    const managed = createManagedMcpUseCases({
      repo: repo as never,
      provisioner,
      probe: { invalidateDiscovery() {} } as never,
      cipher: secretCipher,
      now: () => "2026-01-01T00:00:00.000Z",
      sleep: async () => {},
    });

    const entry = await managed.create({
      name: "image-fetch",
      image: "registry/mcp-image-fetch:v1",
      containerPort: 3000,
    });
    expect(entry.url).toBe(`http://127.0.0.1:${port}/mcp`);

    // The real guard's answer for a loopback address, so the bypass is the only
    // thing that can make this work.
    const policy: UrlPolicy = {
      async assertAllowed(url) {
        throw new BlockedUrlError(`refused: ${url}`);
      },
    };
    const deps = {
      mcps: repo,
      cipher: secretCipher,
      urlPolicy: policy,
      mcpSessions: mcpSessionFactory,
      mcpAuth: { headersFor: async () => ({ headers: {} }), markUnauthorized: async () => {} },
    } as unknown as ExecutionDeps;

    const resolved = await buildMcpTools(deps, {
      projectName: "p",
      mcpList: [{ name: "image-fetch" }],
    } as unknown as Version);

    expect(resolved.warnings).toEqual([]);
    expect(resolved.mcpTools.map((t) => t.function.name)).toEqual(["fetch_image"]);
    expect(resolved.mcpServers[0]?.name).toBe("image-fetch");

    await resolved.close?.();
    await managed.remove("image-fetch", "admin@example.com");
    expect(rows.size).toBe(0);
    await new Promise((done) => server.close(done));
  });
});
