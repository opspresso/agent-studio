import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { brotliCompressSync } from "node:zlib";
import { withTransaction } from "@/infrastructure/db/client";
import { migrate } from "@/infrastructure/db/migrations";
import { convertLegacyAgentDatabase } from "@/infrastructure/db/agentDataMigration";
import { decryptSecret, encryptSecret } from "@/infrastructure/crypto/secretEncryption";
import { agentApiTokenContext, agentMcpHeadersContext, agentVersionMcpHeadersContext, mcpConnectionSecretContext, runtimeSessionContext,
  slackSecretContext, sourceReferenceContext, triggerSecretContext } from "@/domain/security/secretContext";
import { assertLocalDatabase } from "./local-database";

/** Exercise the full old-row → new-row transition without touching the test database's public schema. */
export async function checkAgentDataMigration(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  const schema = `agent_migration_${randomUUID().replaceAll("-", "")}`;
  await withTransaction(async client => {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await migrate(work => work(client));
    await client.query("DELETE FROM schema_migrations WHERE version = 9");
    await client.query("ALTER TABLE runtime_sessions RENAME COLUMN agent_name TO project_name");

    const oldHeaderContext = JSON.stringify([JSON.stringify(["project", "writer", "agent", "mcp", "files"]), "Authorization"]);
    const oldTokenContext = JSON.stringify(["project", "writer", "api-token"]);
    const oldSlackContext = JSON.stringify(["project", "writer", "slack", "bot-token"]);
    const oldSigningContext = JSON.stringify(["project", "writer", "slack", "signing-secret"]);
    const oldConnectionContext = (field: string) => JSON.stringify(["project", "writer", "mcp", "files", field]);
    const oldTriggerContext = JSON.stringify(["project", "writer", "trigger", "hook", "secret"]);
    const oldReferenceContext = JSON.stringify(["project", "writer", "source-reference", "ref", "url"]);
    const rows = [
      { PK: "PROJECT#writer", SK: "META", GSI1PK: "TYPE#PROJECT", GSI1SK: "writer", entityType: "PROJECT",
        name: "writer", displayName: "Writer", description: "", ownerEmail: "owner@example.test",
        createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z",
        configuration: { projectName: "writer", model: "mock-text", systemPrompt: "Leave user projectName text alone",
          parameters: { piiFiltering: false }, mcpList: [{ name: "files", headers: { Authorization: encryptSecret("header", oldHeaderContext) } }],
          skillList: [], subagentList: [] },
        slack: { botToken: encryptSecret("bot", oldSlackContext), signingSecret: encryptSecret("signing", oldSigningContext), enabled: false } },
      { PK: "PROJECT#writer", SK: "APITOKEN", entityType: "APITOKEN", token: encryptSecret("token", oldTokenContext), createdAt: "2026-09-25T00:00:00Z" },
      { PK: "PROJECT#writer", SK: "MCPCONN#files", entityType: "MCPCONNECTION", projectName: "writer", serverName: "files",
        clientSecret: encryptSecret("client", oldConnectionContext("client-secret")),
        accessToken: encryptSecret("access", oldConnectionContext("access-token")),
        refreshToken: encryptSecret("refresh", oldConnectionContext("refresh-token")) },
      { PK: "PROJECT#writer", SK: "TRIGGER#hook", entityType: "Trigger", projectName: "writer", triggerId: "hook",
        secret: encryptSecret("trigger", oldTriggerContext) },
      { PK: "PROJECT#writer", SK: "VERSION#one", entityType: "VERSION", projectName: "writer", versionName: "one",
        mcpList: [{ name: "files", headers: { X: encryptSecret("historical", JSON.stringify([
          JSON.stringify(["project", "writer", "version", "one", "mcp", "files"]), "X",
        ])) } }] },
      { PK: "SOURCEREFERENCE#ref", SK: "META", entityType: "SourceReference",
        reference: { id: "ref", projectName: "writer", encryptedUrl: encryptSecret("https://source.example.test", oldReferenceContext) } },
      { PK: "CHAT#one", SK: "META", entityType: "Chat", projectName: "writer", linkedProjects: { writer: "workspace-one" } },
      { PK: "USAGE#writer", SK: "DATE#2026-09-25", entityType: "Usage", projectName: "writer", date: "2026-09-25", calls: { mock: 1 } },
      { PK: "TRACE#one", SK: "META", entityType: "TRACE", projectName: "writer", projectType: "agent",
        GSI1PK: "TRACEPROJECT#writer", GSI1SK: "2026-09-25T00:00:00Z#one" },
    ];
    for (const row of rows) {
      await client.query("INSERT INTO items (pk,sk,data) VALUES ($1,$2,$3::jsonb)", [row.PK, row.SK, JSON.stringify(row)]);
    }
    const payload = encryptSecret(brotliCompressSync(Buffer.from(JSON.stringify({ format: 1, items: [] }))).toString("base64"),
      runtimeSessionContext("session-one", "owner@example.test"));
    await client.query("INSERT INTO runtime_sessions (session_id,owner_email,project_name,payload,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 day')",
      ["session-one", "owner@example.test", "writer", payload]);

    const result = await convertLegacyAgentDatabase(client, (value, previous, next) => encryptSecret(decryptSecret(value, previous), next));
    assert.equal(result.rows, rows.length);
    assert.equal(result.secrets, 10);
    await migrate(work => work(client));
    const agent = (await client.query<{ data: Record<string, unknown> }>("SELECT data FROM items WHERE pk='AGENT#writer' AND sk='META'")).rows[0]!.data;
    assert.equal(agent.entityType, "AGENT");
    assert.equal((agent.configuration as { agentName: string }).agentName, "writer");
    assert.equal((agent.configuration as { systemPrompt: string }).systemPrompt, "Leave user projectName text alone");
    assert.equal(decryptSecret((agent.slack as { botToken: string }).botToken, slackSecretContext("writer", "bot-token")), "bot");
    const headers = (agent.configuration as { mcpList: Array<{ headers: { Authorization: string } }> }).mcpList[0]!.headers;
    assert.equal(decryptSecret(headers.Authorization, JSON.stringify([agentMcpHeadersContext("writer", "files"), "Authorization"])), "header");
    const token = (await client.query<{ data: { token: string } }>("SELECT data FROM items WHERE pk='AGENT#writer' AND sk='APITOKEN'")).rows[0]!.data.token;
    assert.equal(decryptSecret(token, agentApiTokenContext("writer")), "token");
    const grant = (await client.query<{ data: { clientSecret: string; accessToken: string; refreshToken: string } }>(
      "SELECT data FROM items WHERE pk='AGENT#writer' AND sk='MCPCONN#files'",
    )).rows[0]!.data;
    for (const [stored, field, plaintext] of [[grant.clientSecret, "client-secret", "client"],
      [grant.accessToken, "access-token", "access"], [grant.refreshToken, "refresh-token", "refresh"]] as const) {
      assert.equal(decryptSecret(stored, mcpConnectionSecretContext("writer", "files", field)), plaintext);
    }
    const trigger = (await client.query<{ data: { secret: string } }>(
      "SELECT data FROM items WHERE pk='AGENT#writer' AND sk='TRIGGER#hook'",
    )).rows[0]!.data;
    assert.equal(decryptSecret(trigger.secret, triggerSecretContext("writer", "hook")), "trigger");
    const reference = (await client.query<{ data: { reference: { encryptedUrl: string; agentName: string } } }>(
      "SELECT data FROM items WHERE pk='SOURCEREFERENCE#ref' AND sk='META'",
    )).rows[0]!.data.reference;
    assert.equal(reference.agentName, "writer");
    assert.equal(decryptSecret(reference.encryptedUrl, sourceReferenceContext("writer", "ref")), "https://source.example.test");
    const version = (await client.query<{ data: { mcpList: Array<{ headers: { X: string } }> } }>(
      "SELECT data FROM items WHERE pk='AGENT#writer' AND sk='VERSION#one'",
    )).rows[0]!.data;
    assert.equal(decryptSecret(version.mcpList[0]!.headers.X, JSON.stringify([agentVersionMcpHeadersContext("writer", "one", "files"), "X"])), "historical");
    assert.equal((await client.query("SELECT 1 FROM items WHERE pk LIKE 'PROJECT#%' OR data ? 'projectName'")).rowCount, 0);
    assert.equal((await client.query<{ agent_name: string }>("SELECT agent_name FROM runtime_sessions WHERE session_id='session-one'")).rows[0]!.agent_name, "writer");
    assert.equal((await client.query("SELECT 1 FROM items WHERE gsi1pk='TYPE#AGENT'")).rowCount, 1);
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  console.log("[ok] restored Agent data: item identities, JSON fields, encrypted credentials, indexes and SDK Session column");
}
