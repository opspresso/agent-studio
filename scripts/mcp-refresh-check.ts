import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertLocalDatabase } from "./local-database";
import { createMcpAuthProvider } from "@/application/mcp/mcpAuthProvider";
import { mcpConnectionRepository } from "@/infrastructure/db/repositories/mcpConnectionRepository";
import { mcpRefreshRepository } from "@/infrastructure/db/repositories/mcpRefreshRepository";
import { agentRepository } from "@/infrastructure/db/repositories/agentRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpConnectionSecretContext } from "@/domain/security/secretContext";
import { closePool } from "@/infrastructure/db/client";
import type { McpServerAuth } from "@/domain/mcp/types";

function auth(): McpServerAuth {
  return { type: "oauth2", issuer: "https://fixture.example.test", authorizationServer: "https://fixture.example.test", resource: "https://fixture.example.test/mcp",
    authorizationEndpoint: "https://fixture.example.test/authorize", tokenEndpoint: "https://fixture.example.test/token", tokenEndpointAuthMethod: "none", discoveredAt: "2026-10-01" };
}
async function child(agentName: string, endpoint: string) {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  const provider = createMcpAuthProvider({ connections: mcpConnectionRepository, refreshClaims: mcpRefreshRepository, cipher: secretCipher,
    sleep: async ms => { await sleep(ms); }, oauth: { register: async () => { throw new Error("Unexpected registration"); }, exchangeCode: async () => { throw new Error("Unexpected exchange"); },
      refresh: async (_target, refreshToken) => {
        const response = await fetch(endpoint, { method: "POST", body: refreshToken, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("Fixture token endpoint failed");
        return await response.json();
      } } });
  try {
    const resolved = await provider.headersFor(agentName, "fixture", auth());
    assert.equal(resolved.headers.Authorization, "Bearer fixture-renewed", resolved.unavailable ?? "Expected renewed credential");
    console.log("PASS independent process resolved the renewed credential");
  } finally { await closePool(); }
}

/** Separate Node processes share PostgreSQL; only the external token endpoint is scripted. */
export async function checkMcpRefreshCoordination() {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  const name = `refresh-${randomUUID()}`; const at = new Date().toISOString();
  let refreshCount = 0;
  const server = createServer(async (request, response) => {
    const body: Buffer[] = []; for await (const chunk of request) body.push(Buffer.from(chunk));
    if (Buffer.concat(body).toString() !== "fixture-refresh") { response.writeHead(401).end(); return; }
    refreshCount++;
    await sleep(500);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accessToken: "fixture-renewed", refreshToken: "fixture-rotated", expiresInSeconds: 3600 }));
  });
  try {
    await agentRepository.create({ name, displayName: "Refresh integration", description: "", ownerEmail: "refresh-fixture@example.test", createdAt: at, updatedAt: at });
    await mcpConnectionRepository.put({ agentName: name, serverName: "fixture", clientId: "fixture", issuer: auth().issuer, resource: auth().resource, scopes: [],
      accessToken: secretCipher.encrypt("fixture-old", mcpConnectionSecretContext(name, "fixture", "access-token")),
      refreshToken: secretCipher.encrypt("fixture-refresh", mcpConnectionSecretContext(name, "fixture", "refresh-token")),
      status: "connected", expiresAt: new Date(Date.now() + 1000).toISOString(), updatedAt: at });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts/mcp-refresh-check.ts"), "--child", name, endpoint], { env: process.env });
    const children = await Promise.all([run(), run()]);
    assert.equal(refreshCount, 1, "two processes must present the rotating refresh credential only once");
    assert.ok(children.every(result => result.stdout.includes("PASS")));
    const current = (await mcpConnectionRepository.get(name, "fixture"))!;
    assert.equal(secretCipher.decrypt(current.refreshToken!, mcpConnectionSecretContext(name, "fixture", "refresh-token")), "fixture-rotated");
  } finally {
    if (await agentRepository.get(name)) await agentRepository.delete(name);
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

if (process.argv[2] === "--child") {
  child(process.argv[3]!, process.argv[4]!).catch(() => { console.error("Independent refresh process failed; credentials suppressed"); process.exitCode = 1; });
}
