import { assertLocalDatabase } from "./local-database";

/**
 * End-to-end integration check against a local PostgreSQL and a mock LLM
 * server. Exercises every repository round-trip plus the execution engine
 * (single-shot and agent loop with the builtin Skill tool).
 *
 * Runs against the *test* database (`agent_studio_test`), never the dev one
 * (`agent_studio`): this check writes fixtures and cascade-deletes them.
 *
 *   docker compose up -d postgres
 *   pnpm test:integration
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import type { Task } from "@a2a-js/sdk";

process.env.STAGE ??= "local";
process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@localhost:5432/agent_studio_test";

try {
  assertLocalDatabase(process.env.DATABASE_URL, true);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid database configuration");
  process.exit(1);
}
// Overridable so the check can run beside a `scripts/mock-llm.ts` already
// holding the default port; CI leaves it unset.
const MOCK_PORT = Number(process.env.INTEGRATION_MOCK_PORT ?? 8002);
process.env.LLM_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
process.env.LLM_API_KEY = "test";
process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

async function main() {
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { checkAudioQueueMigration } = await import("./audio-queue-check");
  await checkAudioQueueMigration();
  const { checkRuntimeSessions } = await import("./runtime-session-check");
  await checkRuntimeSessions();
  const { checkAgentConfiguration } = await import("./agent-configuration-check");
  await checkAgentConfiguration();
  const { checkWorkspaces } = await import("./workspace-check");
  await checkWorkspaces();
  const { checkAuthSchema } = await import("./auth-schema-check");
  await checkAuthSchema();
  // Isolate the auth singleton and its environment in a child process.
  execFileSync(process.execPath, ["--import", "tsx", "scripts/keycloak-auth-check.ts"], { stdio: "inherit" });
  const { projectRepository } = await import("@/infrastructure/db/repositories/projectRepository");
  const { workspacePolicyRepository } = await import("@/infrastructure/db/repositories/workspacePolicyRepository");
  const { workspaceRepositoryCreationStore } = await import("@/infrastructure/db/repositories/workspaceRepositoryCreationStore");
  const { createWorkspaceRepositoryCreationUseCases } = await import("@/application/workspace/createRepository");
  const { listProjects } = await import("@/application/project/projectUseCases");
  const { skillRepository } = await import("@/infrastructure/db/repositories/skillRepository");
  const { mcpRepository } = await import("@/infrastructure/db/repositories/mcpRepository");
  const { externalAgentRepository } = await import(
    "@/infrastructure/db/repositories/externalAgentRepository"
  );
  const { chatRepository } = await import("@/infrastructure/db/repositories/chatRepository");
  const { chatRunLogRepository } = await import(
    "@/infrastructure/db/repositories/chatRunLogRepository"
  );
  const { mcpConnectionRepository } = await import(
    "@/infrastructure/db/repositories/mcpConnectionRepository"
  );
  const { listProjectMcpConnections } = await import("@/application/mcp/listConnections");
  const { mcpOAuthStateRepository } = await import(
    "@/infrastructure/db/repositories/mcpOAuthStateRepository"
  );
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const { memberRepository } = await import("@/infrastructure/db/repositories/memberRepository");
  const { createPgVectorStore } = await import("@/infrastructure/vector/pgVectorStore");
  const { runSlotRepository } = await import("@/infrastructure/db/repositories/runSlotRepository");
  const { triggerRepository } = await import("@/infrastructure/db/repositories/triggerRepository");
  const { auditRepository } = await import("@/infrastructure/db/repositories/auditRepository");
  const { listAuditDay } = await import("@/application/audit/auditUseCases");
  const { artifactRepository } = await import(
    "@/infrastructure/db/repositories/artifactRepository"
  );
  const { artifactCursor } = await import("@/domain/artifact/repository");
  const { telegramUpdateRepository } = await import(
    "@/infrastructure/db/repositories/telegramUpdateRepository"
  );
  const { transcriptRepository } = await import(
    "@/infrastructure/db/repositories/transcriptRepository"
  );
  const { executionDeps } = await import("@/lib/container");
  const { executeProject, executeAgent } = await import("@/application/execution/runProject");
  const { encryptHeaders, decryptHeadersForOutbound, encryptSecret, decryptSecret } = await import(
    "@/infrastructure/crypto/secretEncryption"
  );
  const {
    externalAgentHeadersContext,
    mcpConnectionSecretContext,
    mcpHeadersContext,
    mcpOAuthStateContext,
  } = await import("@/domain/security/secretContext");
  const { keys: dbKeys } = await import("@/infrastructure/db/keys");
  const { createA2aTaskStore } = await import("@/infrastructure/a2a/taskStore");
  const { TaskState } = await import("@a2a-js/sdk");
  const { ServerCallContext } = await import("@a2a-js/sdk/server");

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const results: string[] = [];
  const pass = (label: string) => {
    results.push(`PASS ${label}`);
    console.log(`PASS ${label}`);
  };

  // ---------- mock LLM server ----------
  const llmCalls: Array<Record<string, unknown>> = [];
  const mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        stream?: boolean;
        messages: Array<{ role: string; content?: unknown }>;
      };
      llmCalls.push(body);
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      const wantsSkill =
        !hasToolResult &&
        JSON.stringify(body.messages).includes("integration-skill") &&
        JSON.stringify(body).includes('"tools"');

      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (wantsSkill) {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "Skill", arguments: '{"skill_name":"integration-skill"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        } else {
          send({ choices: [{ index: 0, delta: { content: "streamed " }, finish_reason: null }] });
          send({ choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        }
        send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cmpl-1",
            choices: [
              {
                message: { role: "assistant", content: "plain answer" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

  const suffix = Date.now().toString(36);
  const projectName = `it-proj-${suffix}`;
  const a2aOwnerScope = `tenant-${suffix}:client-${suffix}`;
  const legacyDestinationProject = `it-telegram-migration-${suffix}`;
  const legacyDestinationKey = dbKeys.telegramDestination(legacyDestinationProject, 42, 1);
  const integrationMemberId = `it-member-${suffix}`;
  const integrationMemberEmail = `${integrationMemberId}@example.com`;
  const vectorTable = `it_vectors_${suffix}`;
  // Audit rows are the one fixture no repository can remove: the entity is
  // append-only on purpose — a record its subject could erase would not be one —
  // and it lives outside the project partition the cascade clears. Their keys
  // are collected here so the `finally` can delete them through the client,
  // since this table is shared with every other project on the machine.
  const auditFixtures: Array<{ day: string; createdAt: string; eventId: string }> = [];
  // Artifacts are not in the project partition either — they outlive the project
  // the way chats do — so the cascade never reaches them.
  const artifactFixtures: string[] = [];
  // A member's daily rows are keyed by email in their own partition — outside
  // the cascade, and an atomic ADD, so a leftover would accumulate across runs.
  const memberDayFixtures: Array<{ email: string; date: string; project: string }> = [];

  try {
    const { checkManagedMcpTransport } = await import("./managed-mcp-check");
    await checkManagedMcpTransport();
    pass("managed MCP provision, registration and real loopback transport");

    // ---------- schema migration backfill ----------
    const { withTransaction } = await import("@/infrastructure/db/client");
    await withTransaction(async (client) => {
      await client.query("DELETE FROM schema_migrations WHERE version = $1", [5]);
      await client.query(
        "INSERT INTO items (pk, sk, data) VALUES ($1, $2, $3) ON CONFLICT (pk, sk) DO UPDATE SET data = EXCLUDED.data",
        [
          legacyDestinationKey.PK,
          legacyDestinationKey.SK,
          JSON.stringify({
            ...legacyDestinationKey,
            entityType: "telegramDestination",
            projectName: legacyDestinationProject,
            botId: 42,
            chatId: 1,
            chatType: "private",
            title: "Legacy chat",
            lastSeenAt: now,
          }),
        ],
      );
    });
    await migrate();
    const { getItem } = await import("@/infrastructure/db/store");
    assert.deepEqual(await getItem(legacyDestinationKey), {
      ...legacyDestinationKey,
      entityType: "telegramDestination",
      projectName: legacyDestinationProject,
      botId: 42,
      chatId: 1,
      chatType: "private",
      title: "Legacy chat",
      lastSeenAt: now,
      ...dbKeys.telegramDestinationIndexPrefix(legacyDestinationProject, 42),
      GSI2SK: now,
    });
    pass("migration backfills Telegram destination recency index");

    // ---------- project + current settings ----------
    await projectRepository.create({
      name: projectName,
      displayName: "Integration Project",
      description: "integration test",
      projectType: "agent",
      ownerEmail: "it@example.com",
      createdAt: now,
      updatedAt: now,
    });
    const project = await projectRepository.get(projectName);
    assert.ok(project, "project get");
    assert.equal(project.displayName, "Integration Project");
    const listed = await listProjects(projectRepository);
    assert.ok(listed.some((p) => p.name === projectName), "project list contains created");
    pass("project create/get/list");

    const workspacePolicy = { projectName, revision: 1, updatedAt: now, rules: { repositoryOwners: ["integration-owner"] } };
    const policyWrites = await Promise.allSettled([
      workspacePolicyRepository.put(workspacePolicy, null), workspacePolicyRepository.put(workspacePolicy, null),
    ]);
    assert.equal(policyWrites.filter(result => result.status === "fulfilled").length, 1, "one policy writer wins");
    assert.deepEqual((await workspacePolicyRepository.get(projectName))?.rules, workspacePolicy.rules);
    await workspacePolicyRepository.put({ projectName, revision: 2, updatedAt: now }, 1);
    assert.equal((await workspacePolicyRepository.get(projectName))?.rules, undefined, "reset retains revision without an override");
    await assert.rejects(workspacePolicyRepository.put(workspacePolicy, 1), "stale policy edit cannot overwrite reset");
    pass("Workspace repository policy persistence, concurrent edits and reset");

    let repositoryCreates = 0;
    const repositoryRequest = { repository: `integration-owner/new-${suffix}`, description: "Integration fixture", private: true };
    const createRepository = createWorkspaceRepositoryCreationUseCases({ policies: workspacePolicyRepository, creations: workspaceRepositoryCreationStore,
      authorize: async () => {}, now: () => new Date(now), forge: () => ({ createRepository: async request => {
        repositoryCreates++;
        return { repository: request.repository, repositoryId: 42, url: `https://github.example.test/${request.repository}`, baseBranch: "main", private: request.private };
      } }) });
    const repositoryAttempts = await Promise.allSettled([createRepository.create(projectName, repositoryRequest, "it@example.com"), createRepository.create(projectName, repositoryRequest, "it@example.com")]);
    assert.ok(repositoryAttempts.some(result => result.status === "fulfilled"));
    assert.equal(repositoryCreates, 1, "one external create across concurrent requests");
    assert.deepEqual((await workspacePolicyRepository.get(projectName))?.rules?.repositories, [repositoryRequest.repository]);
    assert.equal((await workspaceRepositoryCreationStore.get(projectName, repositoryRequest.repository))?.status, "created");
    assert.equal((await createRepository.create(projectName, repositoryRequest, "it@example.com")).reused, true);
    assert.equal(repositoryCreates, 1, "completed receipt is not recreated");
    pass("Workspace repository creation: durable claim, atomic registration and replay");

    const configuration = {
      projectName, systemPrompt: "You are a helpful integration bot.", model: "integration/model",
      parameters: { piiFiltering: false }, mcpList: [], skillList: ["integration-skill"], subagentList: [], maxTurn: 5,
    };
    const configuredAt = new Date(Date.parse(now) + 1).toISOString();
    await projectRepository.update({ ...project, configuration, updatedAt: configuredAt }, now);
    assert.deepEqual((await projectRepository.get(projectName))?.configuration, configuration);
    pass("current Agent configuration round-trip");
    await assert.rejects(
      projectRepository.update(
        { ...project, description: "stale write", updatedAt: new Date(Date.parse(now) + 2).toISOString() },
        now,
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "ConditionalWriteFailed",
    );
    pass("project optimistic write conflict");

    // ---------- skill ----------
    await skillRepository.put({
      name: "integration-skill",
      description: "Integration testing behavior",
      content: "# Skill\nAlways answer concisely.",
      createdAt: now,
      updatedAt: now,
    });
    assert.ok(await skillRepository.get("integration-skill"), "skill get");
    pass("skill put/get");

    // A projected read, which nothing but the service validates: the doc client
    // accepts any `ProjectionExpression` and the unit tests replace this method
    // entirely, so a name DynamoDB reserves — `name` is one, which is why this
    // projects `description` alone — fails first in production.
    const described = await skillRepository.describe(["integration-skill", "no-such-skill"]);
    assert.deepStrictEqual(
      described,
      [{ name: "integration-skill", description: "Integration testing behavior" }],
      "skill describe returns the description and omits what is not there",
    );
    pass("skill describe (projected, reserved-word alias)");

    // ---------- pgvector adapter ----------
    await withTransaction(async (client) => {
      await client.query(
        `CREATE TABLE ${vectorTable} (key text PRIMARY KEY, embedding vector NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb)`,
      );
    });
    const vectors = createPgVectorStore(vectorTable);
    const vectorA = `${projectName}:a`;
    const vectorB = `${projectName}:b`;
    const vectorC = `${projectName}:c`;
    await vectors.upsert([
      { key: vectorA, vector: [1, 0, 0], metadata: { kind: "skill", label: "A" } },
      { key: vectorB, vector: [0.8, 0.2, 0], metadata: { kind: "skill", label: "B" } },
      { key: vectorC, vector: [0, 1, 0], metadata: { kind: "tool", label: "C" } },
    ]);
    assert.deepEqual(await vectors.listKeys(), [vectorA, vectorB, vectorC]);
    const vectorMatches = await vectors.query([1, 0, 0], 2, { kind: "skill" });
    assert.deepEqual(
      vectorMatches.map((match) => match.key),
      [vectorA, vectorB],
      "cosine order and metadata filter",
    );
    assert.equal(vectorMatches[0]?.metadata.label, "A");
    await vectors.deleteByKeys([vectorB]);
    assert.deepEqual(await vectors.listKeys(), [vectorA, vectorC]);
    pass("pgvector upsert/query/filter/list/delete");

    // ---------- Better Auth member adapter ----------
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, $4, $4)`,
        [integrationMemberId, "Integration Member", integrationMemberEmail, now],
      );
    });
    const memberByEmail = await memberRepository.getByEmail(integrationMemberEmail);
    assert.equal(memberByEmail?.id, integrationMemberId);
    assert.equal(
      (await memberRepository.getById(integrationMemberId))?.email,
      integrationMemberEmail,
    );
    assert.ok(
      (
        await memberRepository.list(10, {
          joinedAt: new Date(Date.parse(now) - 1_000).toISOString(),
          id: "",
        })
      ).some((member) => member.id === integrationMemberId),
      "member list contains inserted user",
    );
    const tierChange = await memberRepository.setTier(integrationMemberId, "member");
    assert.equal(tierChange?.previousTier, "guest");
    assert.equal(tierChange?.member.tier, "member");
    pass("member get/list/atomic tier update");

    // ---------- mcp + external agent (encrypted headers) ----------
    const serverName = `it-mcp-${suffix}`;
    const agentName = `it-agent-${suffix}`;
    const mcpHeaders = encryptHeaders(
      { Authorization: "Bearer secret-token" },
      mcpHeadersContext(serverName),
    );
    await mcpRepository.put({
      name: serverName,
      url: "http://localhost:9999/mcp",
      headers: mcpHeaders,
      createdAt: now,
      updatedAt: now,
    });
    const mcp = await mcpRepository.get(serverName);
    assert.ok(mcp, "mcp get");
    assert.equal(
      decryptHeadersForOutbound(mcp.headers, mcpHeadersContext(serverName)).Authorization,
      "Bearer secret-token",
      "mcp header encryption round-trip",
    );
    await externalAgentRepository.put({
      name: agentName,
      url: "http://localhost:9999/v1/chat/completions",
      description: "external",
      headers: encryptHeaders(
        { Authorization: "Bearer secret-token" },
        externalAgentHeadersContext(agentName),
      ),
      createdAt: now,
      updatedAt: now,
    });
    const agent = await externalAgentRepository.get(agentName);
    assert.ok(agent, "external agent get");
    assert.equal(
      decryptHeadersForOutbound(agent.headers, externalAgentHeadersContext(agentName)).Authorization,
      "Bearer secret-token",
      "external agent header encryption round-trip",
    );
    pass("mcp + external agent with encrypted headers");

    const discoveredAuth = {
      type: "oauth2" as const,
      resource: mcp.url,
      issuer: "https://auth.example.com",
      authorizationServer: "https://auth.example.com",
      authorizationEndpoint: "https://auth.example.com/authorize",
      tokenEndpoint: "https://auth.example.com/token",
      tokenEndpointAuthMethod: "none" as const,
      discoveredAt: now,
    };
    assert.equal(await mcpRepository.updateAuth(serverName, "https://stale.example/mcp", discoveredAuth, now), false);
    assert.equal(await mcpRepository.updateAuth(serverName, mcp.url, discoveredAuth, now), true);
    assert.deepEqual((await mcpRepository.get(serverName))?.auth, discoveredAuth);
    assert.deepEqual((await mcpRepository.get(serverName))?.headers, mcp.headers);
    assert.equal(await mcpRepository.updateAuth(serverName, mcp.url, undefined, now), true);
    assert.equal((await mcpRepository.get(serverName))?.auth, undefined);
    assert.equal(await mcpRepository.updateAuth(`${serverName}-absent`, mcp.url, discoveredAuth, now), false);
    assert.equal(await mcpRepository.get(`${serverName}-absent`), null);
    pass("MCP metadata patch: URL fence, header preservation, clear, missing row refusal");

    // ---------- mcp oauth connection + in-flight state ----------
    await mcpConnectionRepository.put({
      projectName,
      serverName,
      clientId: "client-abc",
      clientSecret: encryptSecret(
        "client-secret",
        mcpConnectionSecretContext(projectName, serverName, "client-secret"),
      ),
      issuer: "https://auth.example.com",
      resource: "https://mcp.example.com",
      scopes: ["chat:write"],
      accessToken: encryptSecret(
        "access-1",
        mcpConnectionSecretContext(projectName, serverName, "access-token"),
      ),
      refreshToken: encryptSecret(
        "refresh-1",
        mcpConnectionSecretContext(projectName, serverName, "refresh-token"),
      ),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      status: "connected",
      connectedBy: "owner@example.com",
      connectedAt: now,
      updatedAt: now,
    });
    const conn = await mcpConnectionRepository.get(projectName, serverName);
    assert.ok(conn, "mcp connection get");
    assert.equal(
      decryptSecret(
        conn.clientSecret ?? "",
        mcpConnectionSecretContext(projectName, serverName, "client-secret"),
      ),
      "client-secret",
      "client secret round-trip",
    );
    // Losing either would silently unbind the credentials and tokens from the
    // servers they belong to — the whole of SEP-2352, and of the audience check
    // that stops a repointed entry carrying them somewhere else.
    assert.equal(conn.issuer, "https://auth.example.com", "credential issuer round-trip");
    assert.equal(conn.resource, "https://mcp.example.com", "token resource round-trip");
    assert.equal(
      (await listProjectMcpConnections(mcpConnectionRepository, projectName)).length,
      1,
      "connection listed under its project partition",
    );

    // Compare-and-set on the grant revision: only the first writer can replace
    // the connection snapshot both callers read.
    const stored = conn.revision;
    assert.equal(
      await mcpConnectionRepository.updateTokens(projectName, serverName, stored, {
        accessToken: encryptSecret(
          "access-2",
          mcpConnectionSecretContext(projectName, serverName, "access-token"),
        ),
        refreshToken: encryptSecret(
          "refresh-2",
          mcpConnectionSecretContext(projectName, serverName, "refresh-token"),
        ),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        status: "connected",
        updatedAt: new Date().toISOString(),
      }),
      true,
      "refresh with the current grant revision wins",
    );
    assert.equal(
      await mcpConnectionRepository.updateTokens(projectName, serverName, stored, {
        accessToken: encryptSecret(
          "access-3",
          mcpConnectionSecretContext(projectName, serverName, "access-token"),
        ),
        refreshToken: encryptSecret(
          "refresh-3",
          mcpConnectionSecretContext(projectName, serverName, "refresh-token"),
        ),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        status: "connected",
        updatedAt: new Date().toISOString(),
      }),
      false,
      "refresh from a superseded grant revision is refused",
    );
    assert.equal(
      decryptSecret(
        (await mcpConnectionRepository.get(projectName, serverName))?.accessToken ?? "",
        mcpConnectionSecretContext(projectName, serverName, "access-token"),
      ),
      "access-2",
      "the winner's token survives the race",
    );

    // Absent values REMOVE rather than storing null. The expected revision is
    // read back from the winner before clearing its tokens.
    const won = await mcpConnectionRepository.get(projectName, serverName);
    assert.equal(
      await mcpConnectionRepository.updateTokens(projectName, serverName, won?.revision, {
        status: "needs_reauth",
        updatedAt: new Date().toISOString(),
      }),
      true,
      "clearing tokens with the stored grant revision succeeds",
    );
    const revoked = await mcpConnectionRepository.get(projectName, serverName);
    assert.equal(revoked?.refreshToken, undefined, "cleared refresh token is absent, not null");
    assert.equal(revoked?.status, "needs_reauth", "status recorded");

    const oauthState = `it-state-${suffix}`;
    await mcpOAuthStateRepository.put(
      {
        state: oauthState,
        projectName,
        serverName,
        codeVerifier: encryptSecret("verifier", mcpOAuthStateContext(oauthState)),
        userEmail: "owner@example.com",
        issuer: "https://auth.example.com",
        issParameterSupported: true,
        createdAt: now,
      },
      600,
    );
    const consumed = await mcpOAuthStateRepository.consume(oauthState);
    assert.equal(consumed?.userEmail, "owner@example.com", "oauth state consumed once");
    // The expected issuer has to survive the round trip or the RFC 9207 check at
    // the callback has nothing to compare against and fails the flow closed.
    assert.equal(consumed?.issuer, "https://auth.example.com", "expected issuer round-trips");
    assert.equal(consumed?.issParameterSupported, true, "iss advertisement round-trips");
    assert.equal(
      decryptSecret(consumed?.codeVerifier ?? "", mcpOAuthStateContext(oauthState)),
      "verifier",
      "PKCE verifier context round-trip",
    );
    assert.equal(
      await mcpOAuthStateRepository.consume(oauthState),
      null,
      "a replayed state is gone",
    );
    pass("mcp oauth connection round-trip + single-use state");

    // ---------- chat ----------
    const chatId = `it-chat-${suffix}`;
    await chatRepository.create({
      chatId,
      title: "Integration chat",
      ownerEmail: "it@example.com",
      projectName,
      createdAt: now,
      updatedAt: now,
    });
    await chatRepository.appendMessage({
      chatId,
      seq: 1,
      role: "user",
      content: "hi",
      createdAt: now,
    });
    await chatRepository.appendMessage({
      chatId,
      seq: 2,
      role: "assistant",
      content: "hello",
      createdAt: now,
    });
    const messages = await chatRepository.listMessages(chatId);
    assert.equal(messages.length, 2, "chat messages round-trip");
    assert.equal(messages[0]?.role, "user");
    const ownChats = await chatRepository.listByOwner("it@example.com");
    assert.ok(ownChats.some((c) => c.chatId === chatId), "chat owner GSI listing");
    assert.equal(
      (await chatRepository.listByOwner("it@example.com", { limit: 1 })).length,
      1,
      "the sidebar's page size bounds the read",
    );
    pass("chat meta/messages/owner listing");

    // ---------- chat run lease + cancel ----------
    // The conditions are the whole point of these two, and a fake document
    // client evaluates none of them.
    assert.equal(await chatRepository.claimRun(chatId, "run-1", 100, 4_102_444_800), true);
    assert.equal(
      await chatRepository.claimRun(chatId, "run-2", 100, 4_102_444_800),
      false,
      "a second run cannot take a live claim",
    );
    assert.deepEqual(await chatRepository.getActiveRun(chatId), {
      runId: "run-1",
      expiresAtSeconds: 4_102_444_800,
    });
    assert.equal(
      await chatRepository.requestCancel(chatId, "run-2"),
      false,
      "a stop aimed at a run that is not the active one is refused",
    );
    assert.equal(await chatRepository.requestCancel(chatId, "run-1"), true);
    assert.ok(
      (await chatRepository.getActiveRun(chatId))?.cancelRequestedAt,
      "the run reads back the stop asked of it",
    );
    // A fresh claim clears the previous run's stop, or the next run dies on its
    // first poll.
    await chatRepository.releaseRun(chatId, "run-1");
    assert.equal(await chatRepository.getActiveRun(chatId), null, "release frees the claim");
    await chatRepository.claimRun(chatId, "run-3", 100, 4_102_444_800);
    assert.equal(
      (await chatRepository.getActiveRun(chatId))?.cancelRequestedAt,
      undefined,
      "a new claim clears the stop the last run was asked for",
    );
    await chatRepository.releaseRun(chatId, "run-3");
    pass("chat run lease + scoped cancel");

    // ---------- chat run log ----------
    const seqBeforeLog = await chatRepository.reserveMessageSeq(chatId);
    // Written past the 9→10 boundary: the padded sort key is what keeps arrival
    // order and sort order the same thing.
    await chatRunLogRepository.append(
      chatId,
      "run-1",
      Array.from({ length: 12 }, (_, seq) => ({
        seq,
        payload: JSON.stringify([{ delta: { content: `part-${seq}` } }]),
      })),
    );
    await chatRunLogRepository.append(chatId, "run-1", [{ seq: 12, payload: "[]", terminal: true }]);
    const replay = await chatRunLogRepository.read(chatId, "run-1", 0);
    assert.deepEqual(
      replay.map((entry) => entry.seq),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      "run log replays in sequence order",
    );
    assert.equal(replay.at(-1)?.terminal, true, "the terminal entry is last");
    assert.deepEqual(
      (await chatRunLogRepository.read(chatId, "run-1", 10)).map((entry) => entry.seq),
      [10, 11, 12],
      "a tail reads only what it has not seen",
    );
    assert.deepEqual(
      await chatRunLogRepository.read(chatId, "run-other", 0),
      [],
      "one run's log is invisible to another's",
    );
    // The log shares the chat's partition; neither of the message readers may
    // pick it up, or a replay row would surface as a message.
    assert.equal(
      (await chatRepository.listMessages(chatId)).length,
      2,
      "run log rows are not chat messages",
    );
    assert.equal(
      await chatRepository.reserveMessageSeq(chatId),
      seqBeforeLog + 1,
      "run log rows do not move the message sequence",
    );
    // Deleting a chat mid-run must not leave its replay rows behind. The cascade
    // sweeps everything but `META` without knowing the log exists, which is the
    // property worth pinning — a future row type inherits it for free.
    const sweptChatId = `it-chat-swept-${suffix}`;
    await chatRepository.create({
      chatId: sweptChatId,
      title: "Swept",
      ownerEmail: "it@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await chatRunLogRepository.append(sweptChatId, "run-1", [{ seq: 0, payload: "[]" }]);
    await chatRepository.delete(sweptChatId);
    await assert.rejects(
      chatRunLogRepository.append(sweptChatId, "run-1", [{ seq: 1, payload: "[]", terminal: true }]),
      { name: "TransactionCancelled" },
      "a late terminal write cannot recreate a deleted chat's log",
    );
    assert.deepEqual(
      await chatRunLogRepository.read(sweptChatId, "run-1", 0),
      [],
      "deleting a chat sweeps its run log",
    );
    // The tail read the thread does on every finished turn, asserted *here*
    // rather than beside the message round-trip above: the bound this is
    // about is the upper one, and what it excludes is the RUNLOG# rows this
    // section just wrote into the same partition. Asserted before they exist,
    // dropping the bound entirely would still have passed.
    const tail = await chatRepository.listMessages(chatId, { sinceSeq: 1 });
    assert.equal(tail.length, 1, "a tail read returns only what came after");
    assert.equal(tail[0]?.seq, 2, "and it is the newer row, not a run log entry");
    assert.equal(
      (await chatRepository.listMessages(chatId, { sinceSeq: 2 })).length,
      0,
      "a tail read caught up returns nothing rather than the run log after it",
    );
    // The last sequence a key can hold, written so the boundary is exercised
    // against a real row rather than against an empty partition: asking for
    // what comes *after* it must be empty, and must not be that row again —
    // which is what clamping the range's lower bound would have returned.
    await chatRepository.appendMessage({
      chatId,
      seq: 999_999,
      role: "assistant",
      content: "last",
      createdAt: now,
    });
    assert.equal(
      (await chatRepository.listMessages(chatId, { sinceSeq: 999_998 })).length,
      1,
      "the last possible sequence is readable as a tail",
    );
    assert.equal(
      (await chatRepository.listMessages(chatId, { sinceSeq: 999_999 })).length,
      0,
      "a tail read past the last possible sequence is empty, not that row again",
    );
    pass("chat run log append/replay/tail + cascade delete");

    // ---------- usage (atomic ADD, twice) ----------
    const usageDelta = {
      projectName,
      date: today,
      model: "openai/gpt-5-mini",
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 80,
      costUsd: 0.001,
    };
    await usageRepository.record(usageDelta);
    await usageRepository.record(usageDelta);
    const rows = await usageRepository.listByProject(projectName, today, today);
    assert.equal(rows.length, 1, "usage row exists");
    assert.equal(rows[0]?.calls["openai/gpt-5-mini"], 2, "usage calls accumulated");
    assert.equal(rows[0]?.inputTokens["openai/gpt-5-mini"], 200, "usage tokens accumulated");
    // A map added after the row shape existed: `if_not_exists` is per attribute,
    // so it materialises on the next write rather than needing a migration.
    assert.equal(
      rows[0]?.cachedTokens?.["openai/gpt-5-mini"],
      160,
      "the cached share accumulates in its own map",
    );
    const rangeRows = await usageRepository.listByDateRange(today, today);
    assert.ok(
      rangeRows.some((r) => r.projectName === projectName),
      "usage date-range GSI listing",
    );
    pass("usage atomic ADD accumulation + range query");

    // ---------- usage attribution (per-caller rows) ----------
    await usageRepository.record({ ...usageDelta, actor: "user:it@example.com" });
    await usageRepository.record({ ...usageDelta, actor: "project-token:it@example.com" });
    const actorRows = await usageRepository.listActorsByProject(projectName, today, today, 100);
    assert.equal(actorRows.length, 2, "one row per caller");
    assert.deepEqual(
      actorRows.map((r) => r.actor).sort(),
      ["project-token:it@example.com", "user:it@example.com"],
      "a token's spend is not merged into its owner's own",
    );
    const projectRows = await usageRepository.listByProject(projectName, today, today);
    assert.equal(projectRows.length, 1, "actor rows do not leak into the project listing");
    assert.equal(
      projectRows[0]?.calls["openai/gpt-5-mini"],
      4,
      "the project total counts attributed calls too",
    );
    pass("usage attribution: per-caller rows, project totals unaffected");

    // ---------- member day rows (one history per email, across actor kinds) ----------
    // The attribution block above also wrote member rows for its fixed address;
    // register it for cleanup, but assert on a per-run address — the row is an
    // atomic ADD keyed by email alone, so a leftover from an interrupted run
    // would otherwise inflate the count.
    memberDayFixtures.push({ email: "it@example.com", date: today, project: projectName });
    const memberEmail = `it-member-${suffix}@example.com`;
    memberDayFixtures.push({ email: memberEmail, date: today, project: projectName });
    await usageRepository.record({ ...usageDelta, actor: `user:${memberEmail}` });
    await usageRepository.record({ ...usageDelta, actor: `project-token:${memberEmail}` });
    // The project follows the date in the sort key, so this range only returns
    // anything if the upper bound reaches past a project name — a plain
    // `BETWEEN DATE#from AND DATE#to` finds nothing at all.
    const memberDays = await usageRepository.listMemberDays(memberEmail, today, today);
    assert.equal(memberDays.length, 1, "one row per member per project per day");
    assert.equal(
      memberDays[0]?.calls["openai/gpt-5-mini"],
      1,
      "token spend stays out of the member's own history",
    );
    assert.equal(memberDays[0]?.projectName, projectName, "the row names where it was spent");
    assert.deepEqual(
      await usageRepository.listMemberDays(`nobody-${suffix}@example.com`, today, today),
      [],
      "an unknown member has no rows",
    );
    // The window the tier cap reads: month start through today.
    const capWindow = await usageRepository.listMemberDays(
      memberEmail,
      `${today.slice(0, 7)}-01`,
      today,
    );
    assert.equal(capWindow.length, 1, "the month-to-date window finds the day");
    pass("member day rows: per-project split, per-actor filtering, range query");

    // ---------- monthly threshold claim (conditional, its own row) ----------
    const month = today.slice(0, 7);
    assert.equal(
      await usageRepository.claimMonthAlert(projectName, month, "alert"),
      true,
      "first monthly claim wins",
    );
    assert.equal(
      await usageRepository.claimMonthAlert(projectName, month, "alert"),
      false,
      "second monthly claim loses",
    );
    assert.equal(
      await usageRepository.claimMonthAlert(projectName, month, "block"),
      true,
      "each threshold keeps its own monthly claim",
    );
    const monthRows = await usageRepository.listByProject(projectName, today, today);
    assert.equal(
      monthRows.length,
      1,
      "the month-claim row does not leak into the daily listing",
    );
    pass("monthly threshold claim: conditional write on its own row");

    // ---------- webhook exactly-once ----------
    // The only thing standing between a redelivered webhook and a second run,
    // and it had never been executed against DynamoDB: every test that exercises
    // delivery uses a `Set`-backed fake, which cannot tell a working condition
    // expression from one that always succeeds. A typo here fails *open* — the
    // claim always wins, the trigger runs twice, and 24 passing tests say
    // nothing about it.
    const hookTrigger = `it-once-${suffix}`;
    const deliveryId = `delivery-${suffix}`;
    assert.equal(
      await triggerRepository.claimIdempotencyKey(projectName, hookTrigger, deliveryId),
      true,
      "the first delivery claims the key",
    );
    assert.equal(
      await triggerRepository.claimIdempotencyKey(projectName, hookTrigger, deliveryId),
      false,
      "a redelivery of the same id is refused",
    );
    assert.equal(
      await triggerRepository.claimIdempotencyKey(projectName, hookTrigger, `${deliveryId}-b`),
      true,
      "a different delivery is not blocked by it",
    );
    // Scoped per trigger, not per project: two triggers can legitimately be
    // handed the same delivery id by different senders.
    assert.equal(
      await triggerRepository.claimIdempotencyKey(projectName, `${hookTrigger}-other`, deliveryId),
      true,
      "the claim is scoped to its own trigger",
    );
    pass("webhook exactly-once: conditional claim, redelivery refused, scoped per trigger");

    // ---------- inbound event claim (lease, settle, reclaim) ----------
    // The one repository every chat platform's webhook dedups through, and the
    // same reasoning as the webhook claim above: a `Set`-backed fake cannot tell
    // a working condition expression from one that always wins.
    const claims = telegramUpdateRepository.forBot(projectName, 42).updates;
    const claimNow = Math.floor(Date.now() / 1000);
    assert.equal(await claims.claim("1001", claimNow, claimNow + 600), true, "first delivery claims");
    assert.equal(
      await claims.claim("1001", claimNow, claimNow + 600),
      false,
      "a redelivery under a live lease is refused",
    );
    await claims.settle("1001", "failed");
    assert.equal(
      await claims.claim("1001", claimNow, claimNow + 600),
      true,
      "a failed attempt leaves the update reclaimable",
    );
    await claims.settle("1001", "done");
    assert.equal(
      await claims.claim("1001", claimNow + 1, claimNow + 601),
      false,
      "a settled update is never reclaimed",
    );
    // An expired lease is reclaimable — the instance that held it is gone.
    assert.equal(await claims.claim("1002", claimNow - 100, claimNow - 50), true, "claim with a past lease");
    assert.equal(await claims.claim("1002", claimNow, claimNow + 600), true, "an expired lease is taken over");
    pass("inbound event claim: lease, failed reclaim, settled never, expired taken over");

    // ---------- conversation transcript (newest N, oldest first, per conversation) ----------
    const conversationKey = `telegram:${suffix}`;
    for (const [index, content] of ["one", "two", "three"].entries()) {
      await transcriptRepository.append(projectName, conversationKey, {
        role: index % 2 === 0 ? "user" : "assistant",
        content,
        createdAt: new Date(Date.parse(now) + index * 1000).toISOString(),
      });
    }
    await transcriptRepository.append(projectName, `${conversationKey}-other`, {
      role: "user",
      content: "elsewhere",
      createdAt: now,
    });
    const recent = await transcriptRepository.recent(projectName, conversationKey, 2);
    assert.deepEqual(
      recent.map((turn) => turn.content),
      ["two", "three"],
      "the newest two turns, oldest first, and only this conversation's",
    );
    pass("conversation transcript: bounded newest-first read, returned oldest first");

    // ---------- trigger history (the repair sweep's bounded window) ----------
    // The bound is a sort-key range, not a filter, and a mocked doc client
    // cannot tell a working KeyConditionExpression from a broken one — which is
    // the whole reason repository queries are checked here.
    const triggerId = `it-hook-${suffix}`;
    const runAt = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const oldRun = { projectName, triggerId, runId: "old", status: "running" as const, startedAt: runAt(3_600_000) };
    const recentRun = { projectName, triggerId, runId: "recent", status: "running" as const, startedAt: runAt(1_000) };
    await triggerRepository.appendRun(oldRun);
    await triggerRepository.appendRun(recentRun);
    const newestFirst = await triggerRepository.listRuns(projectName, triggerId, 10);
    assert.deepEqual(
      newestFirst.map((r) => r.runId),
      ["recent", "old"],
      "trigger runs come back newest first",
    );
    const beforeCutoff = await triggerRepository.listRuns(projectName, triggerId, 10, {
      startedBefore: runAt(60_000),
    });
    assert.deepEqual(
      beforeCutoff.map((r) => r.runId),
      ["old"],
      "startedBefore bounds the window to rows old enough to be dead",
    );
    await triggerRepository.finishRun({
      ...oldRun,
      status: "failed",
      endedAt: now,
      error: "lost",
    });
    const olderRun = { ...oldRun, runId: "older", startedAt: runAt(7_200_000) };
    await triggerRepository.appendRun(olderRun);
    assert.deepEqual(
      (await triggerRepository.listRuns(projectName, triggerId, 1, {
        startedBefore: runAt(60_000),
        status: "running",
      })).map((run) => run.runId),
      ["older"],
      "completed history does not consume the repair query limit",
    );
    assert.equal(
      (await triggerRepository.listRuns(projectName, triggerId, 10)).find((r) => r.runId === "old")
        ?.status,
      "failed",
      "a repaired row is finished in place",
    );
    pass("trigger run history: newest-first, startedBefore window, finish in place");

    // ---------- audit records (day partition, newest first) ----------
    const auditDay = today;
    const auditRows = [
      {
        eventId: `it-audit-a-${suffix}`,
        actorEmail: "it@example.com",
        action: "settings.update" as const,
        target: `settings:app-${suffix}`,
        detail: "adminEmails",
        createdAt: now,
      },
      {
        eventId: `it-audit-b-${suffix}`,
        actorEmail: "it@example.com",
        action: "secret.reveal" as const,
        target: `project:${projectName}`,
        createdAt: new Date(Date.parse(now) + 1000).toISOString(),
      },
    ];
    for (const row of auditRows) {
      await auditRepository.append(row);
      auditFixtures.push({ day: auditDay, createdAt: row.createdAt, eventId: row.eventId });
    }
    const dayRows = await listAuditDay(auditRepository, auditDay);
    const mine = dayRows.filter((row) => row.eventId.endsWith(suffix));
    assert.deepEqual(
      mine.map((row) => row.eventId),
      [`it-audit-b-${suffix}`, `it-audit-a-${suffix}`],
      "audit rows come back newest first within the day",
    );
    assert.equal(mine[1]?.detail, "adminEmails", "detail round-trips");
    assert.equal(mine[0]?.detail, undefined, "an absent detail stays absent");
    pass("audit append + day-partition listing");

    // ---------- artifacts (both indexes, and the sparse one staying sparse) ----------
    // The two indexes are the point: a Slack run names no email, so the project
    // index is the only way its output is ever listed or deleted. Mocked doc
    // clients cannot show that a sparse GSI2 really omits the row.
    const artifactIds = [`it-art-img-${suffix}`, `it-art-doc-${suffix}`, `it-art-slack-${suffix}`];
    const artifactRows = [
      {
        artifactId: artifactIds[0]!,
        kind: "image" as const,
        source: "generated" as const,
        key: `artifacts/image/${artifactIds[0]}.png`,
        mimeType: "image/png",
        byteSize: 2048,
        projectName,
        versionName: "1",
        actor: { kind: "user" as const, id: "it@example.com" },
        prompt: "a poster",
        createdAt: now,
      },
      {
        artifactId: artifactIds[1]!,
        kind: "document" as const,
        source: "generated" as const,
        key: `artifacts/document/${artifactIds[1]}.docx`,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "보고서.docx",
        byteSize: 40960,
        projectName,
        versionName: "1",
        actor: { kind: "user" as const, id: "it@example.com" },
        createdAt: new Date(Date.parse(now) + 1000).toISOString(),
      },
      {
        artifactId: artifactIds[2]!,
        kind: "image" as const,
        source: "generated" as const,
        key: `artifacts/image/${artifactIds[2]}.png`,
        mimeType: "image/png",
        byteSize: 512,
        projectName,
        versionName: "1",
        actor: { kind: "slack" as const, id: "U-integration" },
        createdAt: new Date(Date.parse(now) + 2000).toISOString(),
      },
    ];
    for (const row of artifactRows) {
      await artifactRepository.put(row);
      artifactFixtures.push(row.artifactId);
    }
    const storedArtifact = await artifactRepository.get(artifactIds[1]!);
    assert.equal(storedArtifact?.filename, "보고서.docx", "a Korean filename round-trips");
    assert.equal(storedArtifact?.byteSize, 40960, "byteSize round-trips");

    const byProject = await artifactRepository.listByProject(projectName);
    assert.deepEqual(
      byProject.filter((a) => a.artifactId.endsWith(suffix)).map((a) => a.artifactId),
      [artifactIds[2], artifactIds[1], artifactIds[0]],
      "the project index returns every artifact, newest first",
    );

    const byOwner = await artifactRepository.listByOwner("it@example.com");
    assert.deepEqual(
      byOwner.filter((a) => a.artifactId.endsWith(suffix)).map((a) => a.artifactId),
      [artifactIds[1], artifactIds[0]],
      "the owner index omits the Slack run, whose actor names no mailbox",
    );

    const images = await artifactRepository.listByProject(projectName, { kind: "image" });
    assert.deepEqual(
      images.filter((a) => a.artifactId.endsWith(suffix)).map((a) => a.artifactId),
      [artifactIds[2], artifactIds[0]],
      "the kind filter drops the document",
    );

    // The page cursor is the sort key, and a page excludes its cursor by string
    // equality — so the spelling the listing hands out and the one the adapter
    // compares have to be the same string. `artifactCursor` owns it for both,
    // and this is the round trip that would notice if that stopped being true:
    // the boundary row appears once across the two pages, not twice and not
    // never.
    const firstPage = await artifactRepository.listByProject(projectName, { limit: 2 });
    assert.deepEqual(
      firstPage.map((a) => a.artifactId),
      [artifactIds[2], artifactIds[1]],
      "a page of two returns the two newest",
    );
    const secondPage = await artifactRepository.listByProject(projectName, {
      limit: 2,
      before: artifactCursor(firstPage.at(-1)!),
    });
    assert.deepEqual(
      secondPage.map((a) => a.artifactId),
      [artifactIds[0]],
      "the next page continues past the cursor without repeating it",
    );
    pass("artifact paging: the cursor is the sort key, exclusive and lossless");

    // A filtered page counts *matches*, not rows read. The listing used to
    // filter over what came back and pull up to five extra pages to refill,
    // which meant a match further back than that was invisible — and an empty
    // gallery with no cursor is indistinguishable from having reached the end.
    // Its own project, so the ordering the assertions above pin is untouched.
    const filterProject = `it-filter-${suffix}`;
    const filterBase = Date.parse(now);
    for (let i = 0; i < 40; i += 1) {
      const id = `it-art-fill-${i}-${suffix}`;
      await artifactRepository.put({
        artifactId: id,
        kind: "image" as const,
        source: "generated" as const,
        key: `artifacts/image/${id}.png`,
        mimeType: "image/png",
        byteSize: 128,
        projectName: filterProject,
        versionName: "1",
        actor: { kind: "user" as const, id: "it@example.com" },
        createdAt: new Date(filterBase + 1000 + i * 1000).toISOString(),
      });
      artifactFixtures.push(id);
    }
    const buriedId = `it-art-buried-${suffix}`;
    await artifactRepository.put({
      artifactId: buriedId,
      kind: "document" as const,
      source: "attachment" as const,
      key: `artifacts/document/${buriedId}.pdf`,
      mimeType: "application/pdf",
      byteSize: 1024,
      projectName: filterProject,
      versionName: "1",
      actor: { kind: "user" as const, id: "it@example.com" },
      createdAt: new Date(filterBase).toISOString(),
    });
    artifactFixtures.push(buriedId);
    assert.deepEqual(
      (await artifactRepository.listByProject(filterProject, { limit: 24, kind: "document" })).map(
        (a) => a.artifactId,
      ),
      [buriedId],
      "a document behind forty images is found, not paged past",
    );
    assert.deepEqual(
      (
        await artifactRepository.listByProject(filterProject, {
          limit: 5,
          kind: "image",
          source: "generated",
        })
      ).length,
      5,
      "a filtered page is full at the limit, not thinned by the filter",
    );
    assert.deepEqual(
      await artifactRepository.listByProject(filterProject, { kind: "document", source: "generated" }),
      [],
      "two filters are an AND, so a generated document is not the attached one",
    );
    // `->>` renders whatever is stored as *text*, so a filter matches a number
    // by its digits and matches nothing at all on a row that does not carry the
    // attribute. `tests/fakeStore.ts` claims to answer both the same way, and
    // this is the round trip that would notice if it stopped.
    const { queryItems } = await import("@/infrastructure/db/store");
    const { keys } = await import("@/infrastructure/db/keys");
    assert.deepEqual(
      (
        await queryItems({
          index: "GSI1",
          pk: keys.artifactProjectPartition(filterProject),
          filter: { byteSize: "1024" },
        })
      ).map((row) => row.artifactId),
      [buriedId],
      "a numeric attribute is matched by its text rendering",
    );
    assert.deepEqual(
      await queryItems({
        index: "GSI1",
        pk: keys.artifactProjectPartition(filterProject),
        filter: { nosuchfield: "anything" },
      }),
      [],
      "a row that does not carry the attribute is not a match",
    );
    pass("artifact filters: the store filters before the limit counts");

    await artifactRepository.delete(artifactIds[0]!);
    assert.equal(
      await artifactRepository.get(artifactIds[0]!),
      null,
      "a deleted artifact is gone",
    );
    // Idempotent: the object is removed before the row, so an interrupted delete
    // is retried, and the second attempt must not throw.
    await artifactRepository.delete(artifactIds[0]!);
    pass("artifacts: project + owner indexes, sparse owner index, kind filter, idempotent delete");

    // ---------- A2A client keys (transactional pair + hash lookup) ----------
    const { a2aClientKeyRepository } = await import(
      "@/infrastructure/db/repositories/a2aClientKeyRepository"
    );
    const { listA2aClientKeys } = await import("@/application/a2a/clientKeyUseCases");
    const clientKeyName = `client-${suffix}`;
    const clientKey = {
      name: clientKeyName,
      token: "enc:v1:asc_integration",
      tokenHash: "hash-" + suffix,
      masked: "asc_••••",
      createdAt: new Date().toISOString(),
    };
    await a2aClientKeyRepository.create(clientKey);
    assert.equal(
      (await a2aClientKeyRepository.findNameByHash(clientKey.tokenHash)),
      clientKeyName,
      "hash row resolves to the client name",
    );
    await assert.rejects(
      () => a2aClientKeyRepository.create(clientKey),
      "a duplicate name is refused by the conditional pair",
    );
    assert.ok(
      (await listA2aClientKeys(a2aClientKeyRepository)).some((k) => k.name === clientKeyName),
      "key listed from the TYPE partition",
    );
    await a2aClientKeyRepository.delete(clientKeyName);
    assert.equal(
      await a2aClientKeyRepository.findNameByHash(clientKey.tokenHash),
      null,
      "deletion removes the hash row too",
    );
    pass("A2A client key: transactional pair, hash lookup, full deletion");

    // ---------- inbound A2A task listing (GSI page + exact count) ----------
    const taskContext = new ServerCallContext({
      tenant: `tenant-${suffix}`,
      user: { isAuthenticated: true, userName: `client-${suffix}` },
    });
    const taskStore = createA2aTaskStore(projectName);
    const makeTask = (id: string, timestamp: string): Task => ({
      id,
      contextId: `ctx-${suffix}`,
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp },
      artifacts: [],
      history: [],
      metadata: undefined,
    });
    await taskStore.save(makeTask("task-1", "2026-01-01T00:00:00.000Z"), taskContext);
    await taskStore.save(makeTask("task-2", "2026-01-02T00:00:00.000Z"), taskContext);
    await taskStore.save(makeTask("task-3", "2026-01-03T00:00:00.000Z"), taskContext);
    const taskPage = await taskStore.list(
      {
        tenant: `tenant-${suffix}`,
        contextId: `ctx-${suffix}`,
        status: TaskState.TASK_STATE_COMPLETED,
        pageSize: 2,
        pageToken: "",
        historyLength: 0,
        statusTimestampAfter: undefined,
        includeArtifacts: false,
      },
      taskContext,
    );
    assert.equal(taskPage.totalSize, 3, "task count covers the filtered partition");
    assert.deepEqual(
      taskPage.tasks.map((task) => task.id),
      ["task-3", "task-2"],
      "task page follows the status timestamp index",
    );
    assert.notEqual(taskPage.nextPageToken, "", "a bounded page reports its continuation");
    const taskTail = await taskStore.list(
      {
        tenant: `tenant-${suffix}`,
        contextId: `ctx-${suffix}`,
        status: TaskState.TASK_STATE_COMPLETED,
        pageSize: 2,
        pageToken: taskPage.nextPageToken,
        historyLength: 0,
        statusTimestampAfter: undefined,
        includeArtifacts: false,
      },
      taskContext,
    );
    assert.deepEqual(taskTail.tasks.map((task) => task.id), ["task-1"], "task cursor is exclusive");
    pass("A2A task list: bounded GSI page, exact count, exclusive cursor");

    // ---------- transact lock modes (a checked key does not serialise) ----------
    // A `check` op asserts something elsewhere is still live; the exclusive
    // lock it used to take made every usage row, trace and version write in a
    // project queue on that project's one META row. The two directions that
    // matter: a shared holder must not block a checker, and an exclusive one
    // must still block it — that is the delete the check exists to catch.
    {
      const { transact, conditions } = await import("@/infrastructure/db/store");
      const { getPool } = await import("@/infrastructure/db/client");
      const { keys } = await import("@/infrastructure/db/keys");
      const projectKey = keys.project(projectName);
      const probeKey = keys.trace(`lock-probe-${suffix}`);
      const probe = { ...probeKey, entityType: "TRACE", projectName, createdAt: now };
      const holder = await getPool().connect();
      let writer: Promise<void> | undefined;
      const waited = <T,>(promise: Promise<T>) =>
        Promise.race([
          promise.then(() => "done" as const),
          new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
        ]);
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT pg_advisory_xact_lock_shared(hashtext($1::text), hashtext($2::text))",
          [projectKey.PK, projectKey.SK],
        );
        await holder.query("SELECT data FROM items WHERE pk = $1 AND sk = $2 FOR SHARE", [
          projectKey.PK,
          projectKey.SK,
        ]);
        assert.equal(
          await waited(
            transact([
              { kind: "check", key: projectKey, condition: conditions.exists },
              { kind: "put", item: probe },
            ]),
          ),
          "done",
          "a checked key is taken share-mode, so another reader does not block it",
        );
        // Same key, but written this time: that one waits for the shared holder.
        // An `update` rather than a `put`, so the row keeps what the fixture
        // wrote and the checks after this one still read it.
        writer = transact([
          { kind: "update", key: projectKey, patch: (row) => ({ ...(row ?? {}) }) },
        ]);
        assert.equal(await waited(writer), "waiting", "a write on the key still waits on a reader");
      } finally {
        try {
          await holder.query("ROLLBACK");
        } finally {
          holder.release(true);
        }
      }
      await writer;
      const { deleteItem } = await import("@/infrastructure/db/store");
      await deleteItem(probeKey).catch(() => {});
      pass("transact: a checked key locks share-mode, a written one exclusively");
    }

    // ---------- audio configuration target availability ----------
    {
      const { audioJobConfigRepository: configs } = await import("@/infrastructure/db/repositories/audioJobConfigRepository");
      const target = (await projectRepository.get(projectName))!;
      const config = { projectName, userEmail: target.ownerEmail, revision: 1, enabled: true, model: "integration/asr",
        retention: { unit: "months" as const, value: 3, timezone: "UTC" }, maxActive: 1, maxPerOccurrence: 1,
        postprocess: { projectName }, updatedAt: now };
      assert.equal(await configs.save(config, 0), true);
      const before = (await projectRepository.get(projectName))!;
      assert.deepEqual(before.configuration, target.configuration, "saving a recipe preserves Agent settings");
      assert.equal(await configs.save({ ...config, userEmail: "other@example.test", revision: 2 }, 1), false);
      assert.equal(await configs.save({ ...config, postprocess: { projectName: "missing-target" }, revision: 2 }, 1), false);
      assert.equal((await configs.get(projectName))?.revision, 1);
      const raced = await Promise.all([
        configs.save({ ...config, maxActive: 2, revision: 2 }, 1),
        configs.save({ ...config, maxActive: 3, revision: 2 }, 1),
      ]);
      assert.equal(raced.filter(Boolean).length, 1, "one concurrent recipe update wins");
      pass("audio configuration: current target checks and concurrent recipe CAS");
    }

    // ---------- durable usage receipts ----------
    {
      const event = { idempotencyKey: `asr-${suffix}`, projectName, date: today, model: "asr-integration",
        calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.01, actor: "user:audio-integration@example.com" };
      try {
        await Promise.all(Array.from({ length: 8 }, () => usageRepository.record(event)));
        assert.equal((await usageRepository.getDay(projectName, today))?.calls["asr-integration"], 1);
        // PostgreSQL JSONB reorders object keys; replay compares values, not serialized order.
        await usageRepository.record(event);
        await assert.rejects(usageRepository.record({ ...event, costUsd: 2 }));
        assert.equal((await usageRepository.getDay(projectName, today))?.costUsd["asr-integration"], 0.01);
        pass("usage receipts: concurrent replay bills once and rejects conflicting payloads");
      } finally {
        const { deleteItem } = await import("@/infrastructure/db/store");
        await deleteItem(dbKeys.usageMember("audio-integration@example.com", today, projectName));
      }
    }

    // ---------- source inventory (completion recovery + deletion fencing) ----------
    {
      const { sourceFileRepository: files } = await import("@/infrastructure/db/repositories/sourceFileRepository");
      const { deleteItem } = await import("@/infrastructure/db/store");
      const id = `source-${suffix}`;
      try {
        const pending = await files.create({ id, projectName, userEmail: "integration@example.com",
          filename: "sample.mp3", mimeType: "audio/mpeg", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" },
          revision: 1, status: "pending", createdAt: now, retireAt: now });
        const competing = await Promise.all([
          files.finish(pending, { storedAt: now, retireAt: now, checksum: "sha256", byteSize: 3 }),
          files.finish(pending, { storedAt: now, retireAt: now, checksum: "sha256", byteSize: 3 }),
        ]);
        assert.equal(competing.filter(Boolean).length, 1);
        assert.equal(await files.get(`${projectName}-other`, id), null);
        const ready = (await files.get(projectName, id))!;
        assert.equal(ready.status, "ready");
        const deleting = await files.markDeleting(ready, now);
        assert.ok(deleting);
        assert.equal(await files.finish(pending, { storedAt: now, retireAt: now, checksum: "late", byteSize: 3 }), null);
        assert.equal(await files.markDeleted(deleting, now), true);
        assert.equal((await files.get(projectName, id))?.status, "deleted");
        assert.equal((await files.expired(now, 100)).some((file) => file.id === id), false);
        pass("source inventory: atomic completion, project isolation and deletion fencing");
      } finally {
        await deleteItem(dbKeys.sourceFile(id));
      }
    }

    // ---------- private artifact publication/retirement fence ----------
    {
      const { sourceFileRepository: files } = await import("@/infrastructure/db/repositories/sourceFileRepository");
      const { registerSourceArtifact } = await import("@/application/artifact/storeArtifact");
      const { deleteItem } = await import("@/infrastructure/db/store");
      const id = `source-artifact-${suffix}`;
      try {
        const pending = await files.create({ id, projectName, userEmail: "integration@example.com",
          filename: "sample.mp3", mimeType: "audio/mpeg", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" },
          revision: 1, status: "pending", createdAt: now, retireAt: now });
        const ready = await files.finish(pending, { storedAt: now,
          retireAt: new Date(Date.now() + 86_400_000).toISOString(), checksum: "sha256", byteSize: 3 });
        assert.ok(ready);
        await registerSourceArtifact(artifactRepository, ready);
        assert.ok(await artifactRepository.get(id));
        const [, retirement] = await Promise.allSettled([
          registerSourceArtifact(artifactRepository, ready), files.retire(ready, new Date().toISOString()),
        ]);
        assert.equal(retirement.status, "fulfilled");
        if (retirement.status === "fulfilled") assert.ok(retirement.value);
        await artifactRepository.delete(id);
        await assert.rejects(registerSourceArtifact(artifactRepository, ready));
        assert.equal(await artifactRepository.get(id), null, "delayed publication cannot restore a deleted private artifact");
        pass("private artifacts: publication is fenced against source retirement");
      } finally {
        await artifactRepository.delete(id);
        await deleteItem(dbKeys.sourceFile(id));
      }
    }

    // ---------- durable audio work (admission + worker fencing) ----------
    {
      const { audioJobRepository: jobs } = await import("@/infrastructure/db/repositories/audioJobRepository");
      const input = {
        projectName, userEmail: "integration@example.com", source: { kind: "file" as const, fileId: "audio-file" },
        sourceKey: "integration-source", model: "selfhosted/asr",
        retention: { unit: "months" as const, value: 3, timezone: "Asia/Seoul" },
      };
      const admitted = await Promise.all(Array.from({ length: 8 }, (_, index) => jobs.submit(input, {
        id: `audio-${index}`, now, occurrence: "integration-hour", maxActive: 1, maxPerOccurrence: 1,
      })));
      assert.equal(admitted.filter((result) => result.status === "accepted").length, 1);
      assert.equal(admitted.filter((result) => result.status === "duplicate").length, 7);
      const winner = admitted.find((result) => result.status === "accepted")!;
      assert.ok("job" in winner);
      const job = winner.job;
      const leaseUntil = new Date(Date.parse(now) + 120_000).toISOString();
      const reclaimedAt = new Date(Date.parse(now) + 180_000).toISOString();
      const nextUntil = new Date(Date.parse(now) + 300_000).toISOString();
      const claims = await Promise.all([
        jobs.claim(projectName, job.id, now, "worker-a", leaseUntil),
        jobs.claim(projectName, job.id, now, "worker-b", leaseUntil),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find((value) => value !== null)!;
      const second = await jobs.claim(projectName, job.id, reclaimedAt, "worker-c", nextUntil);
      assert.ok(second);
      assert.equal(await jobs.checkpoint(first, {
        status: "completed", stage: "storing", dueAt: reclaimedAt,
      }, reclaimedAt), null, "expired worker cannot commit results");
      assert.equal(await jobs.heartbeat(second, reclaimedAt, nextUntil), true);
      assert.ok(await jobs.checkpoint(second, { status: "completed", stage: "storing", dueAt: reclaimedAt,
        receipts: { transcript: "document-1" } }, reclaimedAt));
      assert.equal((await jobs.submit(input, {
        id: "audio-replay", now: reclaimedAt, occurrence: "next-hour", maxActive: 1, maxPerOccurrence: 1,
      })).status, "duplicate");
      const next = await jobs.submit({ ...input, sourceKey: "other-source" }, {
        id: "audio-next", now: reclaimedAt, occurrence: "next-hour", maxActive: 1, maxPerOccurrence: 1,
      });
      assert.equal(next.status, "accepted", "terminal job releases its durable project slot");
      assert.equal(await jobs.cancel(projectName, "audio-next", 1, reclaimedAt), true);
      pass("audio jobs: concurrent admission, lease fencing, durable dedup and slot release");

      const queued = await Promise.all(Array.from({ length: 3 }, (_, index) => jobs.submit({ ...input, sourceKey: `queued-source-${index}` }, {
        id: `queued-audio-${index}`, now, occurrence: "queued-hour", maxActive: 3, maxPerOccurrence: 3,
      })));
      assert.equal(queued.filter((result) => result.status === "accepted").length, 3);
      const queue = await getItem(dbKeys.audioJobSlots(projectName));
      const order = queue!.jobIds as string[];
      for (const id of order) {
        const competing = await Promise.all(order.map((candidate) => jobs.claim(projectName, candidate, now, `worker-${candidate}`, leaseUntil)));
        const claimed = competing.filter((job) => job !== null);
        assert.equal(claimed.length, 1, "only the project queue head can be claimed across workers");
        assert.equal(claimed[0]!.id, id, "execution follows transactional admission order");
        assert.ok(await jobs.checkpoint(claimed[0]!, { status: "completed", stage: "cleaning", dueAt: now }, now));
      }
      assert.deepEqual((await getItem(dbKeys.audioJobSlots(projectName)))!.jobIds, []);
      pass("audio jobs: concurrent queue admission and serial FIFO processing across workers");
    }

    // ---------- concurrency slots (conditional claim + lease reclaim) ----------
    const slotActor = `user:slots-${suffix}@example.com`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const firstSlot = await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600);
    const secondSlot = await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600);
    assert.ok(firstSlot && secondSlot, "slots up to the limit are granted");
    assert.notEqual(firstSlot?.index, secondSlot?.index, "each run gets its own index");
    assert.equal(
      await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600),
      null,
      "the limit is exact",
    );
    await runSlotRepository.release(slotActor, firstSlot!);
    assert.ok(
      await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600),
      "a released slot is reusable",
    );
    // An instance that died holds a slot only until its lease runs out.
    const expiredActor = `user:expired-${suffix}@example.com`;
    await runSlotRepository.acquire(expiredActor, 1, nowSeconds - 1);
    assert.ok(
      await runSlotRepository.acquire(expiredActor, 1, nowSeconds + 600),
      "an expired lease is reclaimable",
    );
    pass("concurrency slots: exact limit, release, lease reclaim");

    // ---------- Agent: collected completion ----------
    const runResult = await executeProject(executionDeps, {
      project,
      configuration,
      messages: [{ role: "user", content: "Hello world" }],
    });
    assert.equal(runResult.content, "streamed answer", "executeProject content");
    assert.ok(runResult.usage.inputTokens > 0, "executeProject usage recorded");
    pass("executeProject collected Agent via mock LLM");

    // ---------- engine: agent loop with Skill tool ----------
    const chunks: Array<{ delta?: { content?: string }; toolResult?: unknown; error?: string }> =
      [];
    for await (const chunk of executeAgent(executionDeps, {
      project,
      configuration,
      messages: [{ role: "user", content: "use your skill" }],
      actor: { kind: "user", id: "it@example.com" },
    })) {
      chunks.push(chunk as never);
    }
    const errors = chunks.filter((c) => c.error);
    assert.equal(errors.length, 0, `agent loop errors: ${JSON.stringify(errors)}`);
    const text = chunks.map((c) => c.delta?.content ?? "").join("");
    assert.ok(text.includes("streamed answer"), `agent final text, got: ${JSON.stringify(text)}`);
    assert.ok(
      chunks.some((c) => c.toolResult),
      "agent loop surfaced a Skill tool result",
    );
    assert.ok(llmCalls.length >= 2, "agent loop made a second LLM call after the tool round");
    pass("executeAgent loop with builtin Skill tool");

    // ---------- durable SDK Session + approval over PostgreSQL ----------
    {
      const { pendingRuntimeApproval } = await import("@/application/runtime/session");
      const sessionId = `integration-session-${suffix}`;
      const owner = "it@example.com";
      const approvalConfiguration = { ...configuration, parameters: { ...configuration.parameters, policy: { approvalTools: ["Skill"] } } };
      const base = { project, configuration: approvalConfiguration, actor: { kind: "user" as const, id: owner }, conversation: { surface: "chat" as const, id: sessionId } };
      const first = [];
      for await (const chunk of executeAgent(executionDeps, { ...base, messages: [{ role: "user", content: "use your skill" }] })) first.push(chunk);
      assert.ok(first.some((chunk) => chunk.approval), "approval is persisted before notifying the client");
      assert.ok(!first.some((chunk) => chunk.toolResult), "a pending Skill call has not executed");
      const pending = await pendingRuntimeApproval(executionDeps.runtimeSessions!, sessionId, owner);
      assert.ok(pending && pending.approvals.length === 1);
      const resumed = [];
      for await (const chunk of executeAgent(executionDeps, { ...base, messages: [], resumeApproval: { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] } })) resumed.push(chunk);
      assert.ok(!resumed.some((chunk) => chunk.error), "approved SDK execution resumes successfully");
      assert.ok(resumed.some((chunk) => chunk.toolResult?.name === "Skill: integration-skill"));
      assert.equal(await pendingRuntimeApproval(executionDeps.runtimeSessions!, sessionId, owner), null);
      const before = llmCalls.length;
      for await (const chunk of executeAgent(executionDeps, { ...base, messages: [{ role: "user", content: "continue" }] })) assert.equal(chunk.error, undefined);
      assert.equal(llmCalls.length, before + 1, "the Session replay avoids executing the previous Skill call again");
      await executionDeps.runtimeSessions!.repository.delete(sessionId, owner);
      pass("SDK Session approval persistence, restart-style resume and exact continuation");
    }

    // ---------- cascade delete ----------
    await projectRepository.delete(projectName);
    assert.equal(await projectRepository.get(projectName), null, "project deleted");
    await assert.rejects(
      () => projectRepository.create(project),
      "a deleted project name remains reserved by its tombstone",
    );
    assert.equal(await workspacePolicyRepository.get(projectName), null, "Workspace policy deleted");
    assert.equal(await workspaceRepositoryCreationStore.get(projectName, repositoryRequest.repository), null, "Repository creation receipt deleted");
    await assert.rejects(workspacePolicyRepository.put(workspacePolicy, null), "deleted project cannot regain Workspace access");
    assert.equal(
      (await usageRepository.listByProject(projectName, today, today)).length,
      0,
      "usage rows deleted",
    );
    assert.equal(
      (await transcriptRepository.recent(projectName, `telegram:${suffix}`, 5)).length,
      0,
      "transcript turns deleted with the project",
    );
    pass("project cascade delete (name tombstone + settings + usage + transcript)");
  } finally {
    // cleanup non-cascading fixtures
    await skillRepository.delete("integration-skill").catch(() => {});
    await mcpRepository.delete(`it-mcp-${suffix}`).catch(() => {});
    await externalAgentRepository.delete(`it-agent-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-swept-${suffix}`).catch(() => {});
    await import("@/infrastructure/db/store")
      .then(({ deleteItem }) => deleteItem(legacyDestinationKey))
      .catch(() => {});
    await import("@/infrastructure/db/client")
      .then(({ withTransaction }) =>
        withTransaction(async (client) => {
          await client.query(`DROP TABLE IF EXISTS ${vectorTable}`);
          await client.query(`DELETE FROM "user" WHERE "id" = $1`, [integrationMemberId]);
        }),
      )
      .catch(() => {});
    // The A2A block deletes its own key on the happy path; an assert between
    // create and delete would otherwise leak the pair into the shared table.
    await import("@/infrastructure/db/repositories/a2aClientKeyRepository")
      .then(({ a2aClientKeyRepository }) => a2aClientKeyRepository.delete(`client-${suffix}`))
      .catch(() => {});
    await import("@/infrastructure/db/store")
      .then(({ deletePartition }) =>
        deletePartition(dbKeys.a2aTask(projectName, a2aOwnerScope, "").PK),
      )
      .catch(() => {});
    for (const artifactId of artifactFixtures) {
      await artifactRepository.delete(artifactId).catch(() => {});
    }
    if (auditFixtures.length > 0 || memberDayFixtures.length > 0) {
      const { deleteItem } = await import("@/infrastructure/db/store");
      const { keys } = await import("@/infrastructure/db/keys");
      for (const fixture of auditFixtures) {
        await deleteItem(keys.auditEvent(fixture.day, fixture.createdAt, fixture.eventId)).catch(
          () => {},
        );
      }
      for (const fixture of memberDayFixtures) {
        await deleteItem(keys.usageMember(fixture.email, fixture.date, fixture.project)).catch(
          () => {},
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      mock.close((error) => (error ? reject(error) : resolve()));
    });
    const { closePool } = await import("@/infrastructure/db/client");
    await closePool();
  }

  console.log(`\n${results.length} integration checks passed`);
}

main().catch((error) => {
  console.error("INTEGRATION FAILURE:", error);
  process.exit(1);
});
