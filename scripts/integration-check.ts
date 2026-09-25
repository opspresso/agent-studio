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

let restoreModelSettings: (() => Promise<unknown>) | undefined;
async function main() {
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { settingsRepository } = await import("@/infrastructure/db/repositories/settingsRepository");
  const { registeredModelConfig } = await import("@/domain/llm/providerModels");
  const { replaceModelRegistry } = await import("@/domain/llm/models");
  const previousSettings = await settingsRepository.get();
  restoreModelSettings = () => settingsRepository.update(() => previousSettings ?? { updatedAt: "" });
  const registeredModels = ["openai/gpt-5-mini", "integration/model"].map(id => ({
    id, provider: id.split("/")[0]!, wireId: id.split("/")[1]!, displayName: id, type: "text" as const,
    contextWindow: 128000, maxTokens: 4000,
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  }));
  const { encryptSecret: encryptProviderKey } = await import("@/infrastructure/crypto/secretEncryption");
  const { llmProviderApiKeyContext } = await import("@/domain/security/secretContext");
  const baseUrl = `http://127.0.0.1:${MOCK_PORT}/v1`;
  await settingsRepository.update(current => ({ ...current, registeredModels,
    llmProviders: ["openai", "integration"].map(name => ({ name, kind: "selfhosted" as const, baseUrl,
      apiKey: encryptProviderKey("test", llmProviderApiKeyContext(name, baseUrl)) })), updatedAt: new Date().toISOString() }));
  replaceModelRegistry(registeredModels.map(model => registeredModelConfig(model, "selfhosted")));

  const { checkSchemaBaseline } = await import("./schema-baseline-check");
  await checkSchemaBaseline();
  const { checkRuntimeSessions } = await import("./runtime-session-check");
  await checkRuntimeSessions();
  const { checkWorkspaces } = await import("./workspace-check");
  await checkWorkspaces();
  const { checkAuthSchema } = await import("./auth-schema-check");
  await checkAuthSchema();
  // Isolate the auth singleton and its environment in a child process.
  execFileSync(process.execPath, ["--import", "tsx", "scripts/keycloak-auth-check.ts"], { stdio: "inherit" });
  const { agentRepository } = await import("@/infrastructure/db/repositories/agentRepository");
  const { workspacePolicyRepository } = await import("@/infrastructure/db/repositories/workspacePolicyRepository");
  const { workspaceRepositoryCreationStore } = await import("@/infrastructure/db/repositories/workspaceRepositoryCreationStore");
  const { createWorkspaceRepositoryCreationUseCases } = await import("@/application/workspace/createRepository");
  const { listAgents } = await import("@/application/agent/agentUseCases");
  const { skillRepository } = await import("@/infrastructure/db/repositories/skillRepository");
  const { mcpRepository } = await import("@/infrastructure/db/repositories/mcpRepository");
  const { chatRepository } = await import("@/infrastructure/db/repositories/chatRepository");
  const { chatRunLogRepository } = await import(
    "@/infrastructure/db/repositories/chatRunLogRepository"
  );
  const { mcpConnectionRepository } = await import(
    "@/infrastructure/db/repositories/mcpConnectionRepository"
  );
  const { listAgentMcpConnections } = await import("@/application/mcp/listConnections");
  const { mcpOAuthStateRepository } = await import(
    "@/infrastructure/db/repositories/mcpOAuthStateRepository"
  );
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const { memberRepository } = await import("@/infrastructure/db/repositories/memberRepository");
  const { createPgVectorStore } = await import("@/infrastructure/vector/pgVectorStore");
  const { runSlotRepository } = await import("@/infrastructure/db/repositories/runSlotRepository");
  const { triggerRepository } = await import("@/infrastructure/db/repositories/triggerRepository");
  const { auditRepository } = await import("@/infrastructure/db/repositories/auditRepository");
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
  const { collectAgentRun, executeAgent } = await import("@/application/execution/runAgent");
  const { encryptHeaders, decryptHeadersForOutbound, encryptSecret, decryptSecret } = await import(
    "@/infrastructure/crypto/secretEncryption"
  );
  const {
    mcpConnectionSecretContext,
    mcpHeadersContext,
    mcpOAuthStateContext,
  } = await import("@/domain/security/secretContext");
  const { keys: dbKeys } = await import("@/infrastructure/db/keys");

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
  const agentName = `it-proj-${suffix}`;
  const integrationMemberId = `it-member-${suffix}`;
  const integrationMemberEmail = `${integrationMemberId}@example.com`;
  const vectorTable = `it_vectors_${suffix}`;
  // Audit rows are the one fixture no repository can remove: the entity is
  // append-only on purpose — a record its subject could erase would not be one —
  // and it lives outside the agent partition the cascade clears. Their keys
  // are collected here so the `finally` can delete them through the client,
  // since this table is shared with every other agent on the machine.
  const auditFixtures: Array<{ day: string; createdAt: string; eventId: string }> = [];
  // Artifacts are not in the agent partition either — they outlive the agent
  // the way chats do — so the cascade never reaches them.
  const artifactFixtures: string[] = [];
  // A member's daily rows are keyed by email in their own partition — outside
  // the cascade, and an atomic ADD, so a leftover would accumulate across runs.
  const memberDayFixtures: Array<{ email: string; date: string; agent: string }> = [];

  try {
    const { checkManagedMcpTransport } = await import("./managed-mcp-check");
    await checkManagedMcpTransport();
    pass("managed MCP provision, registration and real loopback transport");
    const { withTransaction } = await import("@/infrastructure/db/client");
    const { getItem } = await import("@/infrastructure/db/store");

    // ---------- agent + current settings ----------
    await agentRepository.create({
      name: agentName,
      displayName: "Integration Agent",
      description: "integration test",
      ownerEmail: "it@example.com",
      createdAt: now,
      updatedAt: now,
    });
    const agent = await agentRepository.get(agentName);
    assert.ok(agent, "agent get");
    assert.equal(agent.displayName, "Integration Agent");
    const listed = await listAgents(agentRepository);
    assert.ok(listed.some((p) => p.name === agentName), "agent list contains created");
    pass("agent create/get/list");

    const { telegramDestinationRepository } = await import("@/infrastructure/db/repositories/telegramDestinationRepository");
    const destination = { chatId: 42, chatType: "private" as const, title: "Integration destination", lastSeenAt: now };
    await telegramDestinationRepository.put(agentName, 7, destination);
    assert.deepEqual(await telegramDestinationRepository.list(agentName, 7, 10), [destination]);
    pass("Telegram destination current index round-trip");

    const workspacePolicy = { agentName, revision: 1, updatedAt: now, rules: { repositoryOwners: ["integration-owner"] } };
    const policyWrites = await Promise.allSettled([
      workspacePolicyRepository.put(workspacePolicy, null), workspacePolicyRepository.put(workspacePolicy, null),
    ]);
    assert.equal(policyWrites.filter(result => result.status === "fulfilled").length, 1, "one policy writer wins");
    assert.deepEqual((await workspacePolicyRepository.get(agentName))?.rules, workspacePolicy.rules);
    await workspacePolicyRepository.put({ agentName, revision: 2, updatedAt: now }, 1);
    assert.equal((await workspacePolicyRepository.get(agentName))?.rules, undefined, "reset retains revision without an override");
    await assert.rejects(workspacePolicyRepository.put(workspacePolicy, 1), "stale policy edit cannot overwrite reset");
    pass("Workspace repository policy persistence, concurrent edits and reset");

    let repositoryCreates = 0;
    const repositoryRequest = { repository: `integration-owner/new-${suffix}`, description: "Integration fixture", private: true };
    const createRepository = createWorkspaceRepositoryCreationUseCases({ policies: workspacePolicyRepository, creations: workspaceRepositoryCreationStore,
      authorize: async () => {}, now: () => new Date(now), forge: () => ({ createRepository: async request => {
        repositoryCreates++;
        return { repository: request.repository, repositoryId: 42, url: `https://github.example.test/${request.repository}`, baseBranch: "main", private: request.private };
      } }) });
    const repositoryAttempts = await Promise.allSettled([createRepository.create(agentName, repositoryRequest, "it@example.com"), createRepository.create(agentName, repositoryRequest, "it@example.com")]);
    assert.ok(repositoryAttempts.some(result => result.status === "fulfilled"));
    assert.equal(repositoryCreates, 1, "one external create across concurrent requests");
    assert.deepEqual((await workspacePolicyRepository.get(agentName))?.rules?.repositories, [repositoryRequest.repository]);
    assert.equal((await workspaceRepositoryCreationStore.get(agentName, repositoryRequest.repository))?.status, "created");
    assert.equal((await createRepository.create(agentName, repositoryRequest, "it@example.com")).reused, true);
    assert.equal(repositoryCreates, 1, "completed receipt is not recreated");
    pass("Workspace repository creation: durable claim, atomic registration and replay");

    const configuration = {
      agentName, systemPrompt: "You are a helpful integration bot.", model: "integration/model",
      parameters: { piiFiltering: false }, mcpList: [], skillList: ["integration-skill"], subagentList: [], maxTurn: 5,
    };
    const configuredAt = new Date(Date.parse(now) + 1).toISOString();
    await agentRepository.update({ ...agent, configuration, updatedAt: configuredAt }, now);
    assert.deepEqual((await agentRepository.get(agentName))?.configuration, configuration);
    pass("current Agent configuration round-trip");
    await assert.rejects(
      agentRepository.update(
        { ...agent, description: "stale write", updatedAt: new Date(Date.parse(now) + 2).toISOString() },
        now,
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "ConditionalWriteFailed",
    );
    pass("agent optimistic write conflict");

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

    // Exercise the repository's projected SQL read: unit tests replace this
    // method, so only this check proves it returns descriptions in caller order
    // and omits missing skills.
    const described = await skillRepository.describe(["integration-skill", "no-such-skill"]);
    assert.deepStrictEqual(
      described,
      [{ name: "integration-skill", description: "Integration testing behavior" }],
      "skill describe returns the description and omits what is not there",
    );
    pass("skill describe projected SQL read");

    // ---------- pgvector adapter ----------
    await withTransaction(async (client) => {
      await client.query(
        `CREATE TABLE ${vectorTable} (key text PRIMARY KEY, embedding vector NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb)`,
      );
    });
    const vectors = createPgVectorStore(vectorTable);
    const vectorA = `${agentName}:a`;
    const vectorB = `${agentName}:b`;
    const vectorC = `${agentName}:c`;
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

    // ---------- MCP encrypted headers ----------
    const serverName = `it-mcp-${suffix}`;
    const mcpHeaders = encryptHeaders(
      { Authorization: "Bearer secret-token" },
      mcpHeadersContext(serverName),
    );
    const sourceOutputs = [{ tool: "get_file", namespace: "plaud", urlPath: ["presigned_url"],
      idPath: ["id"], namePath: ["name"], mimeType: "audio/mpeg", refreshArgument: "file_id" }];
    await mcpRepository.put({
      name: serverName,
      url: "http://localhost:9999/mcp",
      headers: mcpHeaders,
      sourceOutputs,
      createdAt: now,
      updatedAt: now,
    });
    const mcp = await mcpRepository.get(serverName);
    assert.ok(mcp, "mcp get");
    assert.deepEqual(mcp.sourceOutputs, sourceOutputs, "MCP source defaults survive JSONB round-trip");
    assert.equal(
      decryptHeadersForOutbound(mcp.headers, mcpHeadersContext(serverName)).Authorization,
      "Bearer secret-token",
      "mcp header encryption round-trip",
    );
    pass("MCP encrypted headers");

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
      agentName,
      serverName,
      clientId: "client-abc",
      clientSecret: encryptSecret(
        "client-secret",
        mcpConnectionSecretContext(agentName, serverName, "client-secret"),
      ),
      issuer: "https://auth.example.com",
      resource: "https://mcp.example.com",
      scopes: ["chat:write"],
      accessToken: encryptSecret(
        "access-1",
        mcpConnectionSecretContext(agentName, serverName, "access-token"),
      ),
      refreshToken: encryptSecret(
        "refresh-1",
        mcpConnectionSecretContext(agentName, serverName, "refresh-token"),
      ),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      status: "connected",
      connectedBy: "owner@example.com",
      connectedAt: now,
      updatedAt: now,
    });
    const conn = await mcpConnectionRepository.get(agentName, serverName);
    assert.ok(conn, "mcp connection get");
    assert.equal(
      decryptSecret(
        conn.clientSecret ?? "",
        mcpConnectionSecretContext(agentName, serverName, "client-secret"),
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
      (await listAgentMcpConnections(mcpConnectionRepository, agentName)).length,
      1,
      "connection listed under its agent partition",
    );

    // Compare-and-set on the grant revision: only the first writer can replace
    // the connection snapshot both callers read.
    const stored = conn.revision;
    assert.equal(
      await mcpConnectionRepository.updateTokens(agentName, serverName, stored, {
        accessToken: encryptSecret(
          "access-2",
          mcpConnectionSecretContext(agentName, serverName, "access-token"),
        ),
        refreshToken: encryptSecret(
          "refresh-2",
          mcpConnectionSecretContext(agentName, serverName, "refresh-token"),
        ),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        status: "connected",
        updatedAt: new Date().toISOString(),
      }),
      true,
      "refresh with the current grant revision wins",
    );
    assert.equal(
      await mcpConnectionRepository.updateTokens(agentName, serverName, stored, {
        accessToken: encryptSecret(
          "access-3",
          mcpConnectionSecretContext(agentName, serverName, "access-token"),
        ),
        refreshToken: encryptSecret(
          "refresh-3",
          mcpConnectionSecretContext(agentName, serverName, "refresh-token"),
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
        (await mcpConnectionRepository.get(agentName, serverName))?.accessToken ?? "",
        mcpConnectionSecretContext(agentName, serverName, "access-token"),
      ),
      "access-2",
      "the winner's token survives the race",
    );

    // Absent values REMOVE rather than storing null. The expected revision is
    // read back from the winner before clearing its tokens.
    const won = await mcpConnectionRepository.get(agentName, serverName);
    assert.equal(
      await mcpConnectionRepository.updateTokens(agentName, serverName, won?.revision, {
        status: "needs_reauth",
        updatedAt: new Date().toISOString(),
      }),
      true,
      "clearing tokens with the stored grant revision succeeds",
    );
    const revoked = await mcpConnectionRepository.get(agentName, serverName);
    assert.equal(revoked?.refreshToken, undefined, "cleared refresh token is absent, not null");
    assert.equal(revoked?.status, "needs_reauth", "status recorded");
    assert.ok(revoked, "revoked connection remains available for a conditional replacement");
    assert.equal(await mcpConnectionRepository.putIfCurrent({ ...conn, clientId: "stale" }, conn),
      false, "a stale authorization cannot replace the current grant");
    assert.equal(await mcpConnectionRepository.putIfCurrent({ ...revoked, clientId: "replacement" }, revoked),
      true, "the current grant may be replaced");
    assert.equal(await mcpConnectionRepository.deleteIfCurrent(revoked),
      false, "a stale disconnect cannot remove a replacement grant");
    assert.equal((await mcpConnectionRepository.get(agentName, serverName))?.clientId,
      "replacement", "the replacement grant survives the stale disconnect");

    const oauthState = `it-state-${suffix}`;
    await mcpOAuthStateRepository.put(
      {
        state: oauthState,
        agentName,
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
      agentName,
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
    const listOwner = `it-chat-list-${suffix}@example.com`;
    const ordinaryListChatId = `it-chat-list-ordinary-${suffix}`;
    const workspaceListChatId = `it-chat-list-workspace-${suffix}`;
    await chatRepository.create({ chatId: workspaceListChatId, title: "Workspace list item", ownerEmail: listOwner,
      workspaceId: `it-workspace-${suffix}`, createdAt: now, updatedAt: new Date(Date.parse(now) - 1000).toISOString() });
    await chatRepository.create({ chatId: ordinaryListChatId, title: "Chat list item", ownerEmail: listOwner,
      createdAt: now, updatedAt: now });
    assert.deepEqual(
      (await chatRepository.listByOwner(listOwner, { kind: "workspace", limit: 1 })).map(item => item.chatId),
      [workspaceListChatId],
      "workspace membership is filtered before the page limit",
    );
    assert.deepEqual(
      (await chatRepository.listByOwner(listOwner, { kind: "chat", limit: 1 })).map(item => item.chatId),
      [ordinaryListChatId],
      "ordinary Chats exclude Workspace-owned rows before the page limit",
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
      agentName,
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
    const rows = await usageRepository.listByAgent(agentName, today, today);
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
      rangeRows.some((r) => r.agentName === agentName),
      "usage date-range GSI listing",
    );
    pass("usage atomic ADD accumulation + range query");

    // ---------- usage attribution (per-caller rows) ----------
    await usageRepository.record({ ...usageDelta, actor: "user:it@example.com" });
    await usageRepository.record({ ...usageDelta, actor: "agent-token:it@example.com" });
    const actorRows = await usageRepository.listActorsByAgent(agentName, today, today, 100);
    assert.equal(actorRows.length, 2, "one row per caller");
    assert.deepEqual(
      actorRows.map((r) => r.actor).sort(),
      ["agent-token:it@example.com", "user:it@example.com"],
      "a token's spend is not merged into its owner's own",
    );
    const agentRows = await usageRepository.listByAgent(agentName, today, today);
    assert.equal(agentRows.length, 1, "actor rows do not leak into the agent listing");
    assert.equal(
      agentRows[0]?.calls["openai/gpt-5-mini"],
      4,
      "the agent total counts attributed calls too",
    );
    pass("usage attribution: per-caller rows, agent totals unaffected");

    // ---------- member day rows (one history per email, across actor kinds) ----------
    // The attribution block above also wrote member rows for its fixed address;
    // register it for cleanup, but assert on a per-run address — the row is an
    // atomic ADD keyed by email alone, so a leftover from an interrupted run
    // would otherwise inflate the count.
    memberDayFixtures.push({ email: "it@example.com", date: today, agent: agentName });
    const memberEmail = `it-member-${suffix}@example.com`;
    memberDayFixtures.push({ email: memberEmail, date: today, agent: agentName });
    await usageRepository.record({ ...usageDelta, actor: `user:${memberEmail}` });
    await usageRepository.record({ ...usageDelta, actor: `agent-token:${memberEmail}` });
    // The agent follows the date in the sort key, so this range only returns
    // anything if the upper bound reaches past an agent name — a plain
    // `BETWEEN DATE#from AND DATE#to` finds nothing at all.
    const memberDays = await usageRepository.listMemberDays(memberEmail, today, today);
    assert.equal(memberDays.length, 1, "one row per member per agent per day");
    assert.equal(
      memberDays[0]?.calls["openai/gpt-5-mini"],
      1,
      "token spend stays out of the member's own history",
    );
    assert.equal(memberDays[0]?.agentName, agentName, "the row names where it was spent");
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
    pass("member day rows: per-agent split, per-actor filtering, range query");

    // ---------- monthly threshold claim (conditional, its own row) ----------
    const month = today.slice(0, 7);
    assert.equal(
      await usageRepository.claimMonthAlert(agentName, month, "alert"),
      true,
      "first monthly claim wins",
    );
    assert.equal(
      await usageRepository.claimMonthAlert(agentName, month, "alert"),
      false,
      "second monthly claim loses",
    );
    assert.equal(
      await usageRepository.claimMonthAlert(agentName, month, "block"),
      true,
      "each threshold keeps its own monthly claim",
    );
    const monthRows = await usageRepository.listByAgent(agentName, today, today);
    assert.equal(
      monthRows.length,
      1,
      "the month-claim row does not leak into the daily listing",
    );
    pass("monthly threshold claim: conditional write on its own row");

    // ---------- webhook exactly-once ----------
    // The only thing standing between a redelivered webhook and a second run.
    // Unit tests use a `Set`-backed fake, which cannot prove the PostgreSQL
    // conditional write is atomic. A typo here fails *open* — the
    // claim always wins, the trigger runs twice, and 24 passing tests say
    // nothing about it.
    const hookTrigger = `it-once-${suffix}`;
    const deliveryId = `delivery-${suffix}`;
    assert.equal(
      await triggerRepository.claimIdempotencyKey(agentName, hookTrigger, deliveryId),
      true,
      "the first delivery claims the key",
    );
    assert.equal(
      await triggerRepository.claimIdempotencyKey(agentName, hookTrigger, deliveryId),
      false,
      "a redelivery of the same id is refused",
    );
    assert.equal(
      await triggerRepository.claimIdempotencyKey(agentName, hookTrigger, `${deliveryId}-b`),
      true,
      "a different delivery is not blocked by it",
    );
    // Scoped per trigger, not per agent: two triggers can legitimately be
    // handed the same delivery id by different senders.
    assert.equal(
      await triggerRepository.claimIdempotencyKey(agentName, `${hookTrigger}-other`, deliveryId),
      true,
      "the claim is scoped to its own trigger",
    );
    pass("webhook exactly-once: conditional claim, redelivery refused, scoped per trigger");

    // ---------- inbound event claim (lease, settle, reclaim) ----------
    // The one repository every chat platform's webhook dedups through, and the
    // same reasoning as the webhook claim above: a `Set`-backed fake cannot tell
    // a working condition expression from one that always wins.
    const claims = telegramUpdateRepository.forBot(agentName, 42).updates;
    const claimNow = Math.floor(Date.now() / 1000);
    const firstClaim = await claims.claim("1001", claimNow, claimNow + 600);
    assert.ok(firstClaim, "first delivery claims");
    assert.equal(
      await claims.claim("1001", claimNow, claimNow + 600),
      null,
      "a redelivery under a live lease is refused",
    );
    await claims.settle("1001", firstClaim, "failed");
    const retriedClaim = await claims.claim("1001", claimNow, claimNow + 600);
    assert.ok(retriedClaim, "a failed attempt leaves the update reclaimable");
    assert.notEqual(retriedClaim, firstClaim, "a retry in the same second receives a new token");
    await claims.settle("1001", firstClaim, "done");
    await claims.settle("1001", retriedClaim, "failed");
    const currentClaim = await claims.claim("1001", claimNow, claimNow + 600);
    assert.ok(currentClaim, "the old holder cannot retire the retry");
    await claims.settle("1001", currentClaim, "done");
    await claims.settle("1001", currentClaim, "failed");
    assert.equal(
      await claims.claim("1001", claimNow + 1, claimNow + 601),
      null,
      "a settled update is never reclaimed",
    );
    for (const outcome of ["done", "failed"] as const) {
      const eventId = `expired-${outcome}`;
      const expired = await claims.claim(eventId, claimNow - 100, claimNow - 50);
      assert.ok(expired, "claim with a past lease");
      // The row lock must allow only one replacement to win.
      const candidates = await Promise.all([
        claims.claim(eventId, claimNow, claimNow + 600),
        claims.claim(eventId, claimNow, claimNow + 600),
      ]);
      const winners = candidates.filter((token): token is string => token !== null);
      assert.equal(winners.length, 1, "one holder reclaims the expired lease");
      const replacement = winners[0]!;
      assert.notEqual(replacement, expired);
      await claims.settle(eventId, expired, outcome);
      await claims.settle(eventId, "wrong-token", outcome);
      assert.equal(await claims.claim(eventId, claimNow, claimNow + 600), null, "late failure cannot release another holder's claim");
      await claims.settle(eventId, replacement, "failed");
      assert.ok(await claims.claim(eventId, claimNow, claimNow + 600), "late success cannot retire another holder's claim");
    }
    pass("inbound event claim: token ownership, concurrent reclaim, failed retry and terminal settlement");

    // Stop events can reach a different replica, and may be delivered out of order.
    const { slackRunControlRepository: slackControl } = await import("@/infrastructure/db/repositories/slackRunControlRepository");
    const slackRunTarget = { agentName, channel: "C1", threadTs: "1.0" };
    await Promise.all(["2.8", "2.3", "2.7"].map((ts) => slackControl.requestStop(slackRunTarget, ts)));
    assert.equal(await slackControl.stoppedAfter(slackRunTarget, "2.7"), true);
    assert.equal(await slackControl.stoppedAfter(slackRunTarget, "2.9"), false);
    assert.equal(await slackControl.stoppedAfter({ ...slackRunTarget, channel: "C2" }, "2.7"), false);
    await assert.rejects(slackControl.requestStop({ ...slackRunTarget, agentName: `missing-${suffix}` }, "2.8"));
    pass("Slack stop delivery: concurrent watermark, subsequent-message isolation and agent fence");
    const slackLeases = await Promise.all([slackControl.acquire(slackRunTarget), slackControl.acquire(slackRunTarget)]);
    const leaseWinners = slackLeases.filter((token): token is string => token !== null);
    assert.equal(leaseWinners.length, 1);
    assert.equal(await slackControl.renew(slackRunTarget, leaseWinners[0]!), true);
    await slackControl.release(slackRunTarget, "stale-owner");
    assert.equal(await slackControl.acquire(slackRunTarget), null);
    await slackControl.release(slackRunTarget, leaseWinners[0]!);
    const nextSlackLease = await slackControl.acquire(slackRunTarget);
    assert.ok(nextSlackLease);
    await slackControl.release(slackRunTarget, nextSlackLease);
    pass("Slack thread lease: concurrent admission, renewal and owner-scoped release");

    // ---------- conversation transcript (newest N, oldest first, per conversation) ----------
    const conversationKey = `telegram:${suffix}`;
    for (const [index, content] of ["one", "two", "three"].entries()) {
      await transcriptRepository.append(agentName, conversationKey, {
        role: index % 2 === 0 ? "user" : "assistant",
        content,
        createdAt: new Date(Date.parse(now) + index * 1000).toISOString(),
      });
    }
    await transcriptRepository.append(agentName, `${conversationKey}-other`, {
      role: "user",
      content: "elsewhere",
      createdAt: now,
    });
    const recent = await transcriptRepository.recent(agentName, conversationKey, 2);
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
    const oldRun = { agentName, triggerId, runId: "old", status: "running" as const, startedAt: runAt(3_600_000) };
    const recentRun = { agentName, triggerId, runId: "recent", status: "running" as const, startedAt: runAt(1_000) };
    await triggerRepository.appendRun(oldRun);
    await triggerRepository.appendRun(recentRun);
    const newestFirst = await triggerRepository.listRuns(agentName, triggerId, 10);
    assert.deepEqual(
      newestFirst.map((r) => r.runId),
      ["recent", "old"],
      "trigger runs come back newest first",
    );
    const beforeCutoff = await triggerRepository.listRuns(agentName, triggerId, 10, {
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
      (await triggerRepository.listRuns(agentName, triggerId, 1, {
        startedBefore: runAt(60_000),
        status: "running",
      })).map((run) => run.runId),
      ["older"],
      "completed history does not consume the repair query limit",
    );
    assert.equal(
      (await triggerRepository.listRuns(agentName, triggerId, 10)).find((r) => r.runId === "old")
        ?.status,
      "failed",
      "a repaired row is finished in place",
    );
    pass("trigger run history: newest-first, startedBefore window, finish in place");

    {
      const reviewTrigger = { agentName, triggerId: "webhook", kind: "webhook" as const, secret: "integration-encrypted-secret",
        description: "PR reviews", enabled: true, allowConcurrent: true, createdAt: now, updatedAt: now,
        githubReview: { scope: "repositories" as const, repositories: ["example/agent"] } };
      await triggerRepository.create(reviewTrigger);
      assert.deepEqual((await triggerRepository.get(agentName, "webhook")), reviewTrigger);
      const review = { repository: "example/agent", number: 42, headSha: "a".repeat(40), status: "posted" as const,
        url: "https://github.com/example/agent/pull/42#pullrequestreview-1" };
      await triggerRepository.finishRun({ ...recentRun, status: "succeeded", endedAt: now, review });
      assert.deepEqual((await triggerRepository.listRuns(agentName, triggerId, 1))[0]?.review, review);
      pass("PR review trigger authorization and publication receipt persist through PostgreSQL");
    }

    // ---------- queued schedule ownership and atomic dispatch ----------
    const queueTrigger = `it-queue-${suffix}`;
    const queueNow = Date.now();
    const queuedRun = { agentName, triggerId: queueTrigger, runId: "queued", status: "queued" as const,
      queuedAt: new Date(queueNow - 60_000).toISOString(), queueLeaseUntil: new Date(queueNow + 60_000).toISOString() };
    await triggerRepository.appendRun(queuedRun);
    const renewedQueue = { ...queuedRun, queueLeaseUntil: new Date(queueNow + 120_000).toISOString() };
    assert.equal(await triggerRepository.updateQueuedRun(queuedRun, renewedQueue), true);
    assert.equal(await triggerRepository.updateQueuedRun(queuedRun, { ...queuedRun, status: "failed", endedAt: now }), false,
      "stale repair cannot close a renewed queue owner");
    const { queueLeaseUntil: _queueLease, ...queueIdentity } = renewedQueue;
    void _queueLease;
    const runningQueue = { ...queueIdentity, status: "running" as const, startedAt: new Date().toISOString() };
    const starts = await Promise.all([
      triggerRepository.updateQueuedRun(renewedQueue, runningQueue),
      triggerRepository.updateQueuedRun(renewedQueue, runningQueue),
    ]);
    assert.equal(starts.filter(Boolean).length, 1, "one queued-to-running transition wins");
    assert.deepEqual(await triggerRepository.listRuns(agentName, queueTrigger, 10), [runningQueue]);
    assert.equal(await getItem(dbKeys.triggerRun(agentName, queueTrigger, queuedRun.queuedAt, queuedRun.runId)), null,
      "moving to the actual start key leaves no duplicate history");
    assert.deepEqual(await triggerRepository.listRuns(agentName, queueTrigger, 10, { status: "queued" }), []);
    const expiredQueue = { ...queuedRun, runId: "expired", queueLeaseUntil: new Date(queueNow - 1).toISOString() };
    await triggerRepository.appendRun({ ...expiredQueue, runId: "past-retention", queuedAt: "1970-01-01T00:00:00.000Z", queueLeaseUntil: "1970-01-01T00:01:00.000Z" });
    await triggerRepository.appendRun(expiredQueue);
    await triggerRepository.appendRun({ ...queuedRun, runId: "live" });
    assert.deepEqual(await triggerRepository.listRuns(agentName, queueTrigger, 1, {
      status: "queued", queueLeaseBefore: new Date(queueNow).toISOString(),
    }), [expiredQueue], "expiry and lease windows are applied before the queue repair limit");
    assert.equal(await triggerRepository.updateQueuedRun(expiredQueue, { ...expiredQueue, status: "running", startedAt: now }), false);
    assert.equal(await triggerRepository.updateQueuedRun(expiredQueue, { ...expiredQueue, status: "failed", endedAt: now }), true);
    pass("schedule queue: renewal fencing, concurrent dispatch, atomic key move and bounded repair");

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
        target: `agent:${agentName}`,
        createdAt: new Date(Date.parse(now) + 1000).toISOString(),
      },
    ];
    for (const row of auditRows) {
      await auditRepository.append(row);
      auditFixtures.push({ day: auditDay, createdAt: row.createdAt, eventId: row.eventId });
    }
    const dayRows = await auditRepository.listByDay(auditDay, 100);
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
    // The two indexes are the point: a Slack run names no email, so the agent
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
        agentName,
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
        agentName,
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
        agentName,
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

    const byAgent = await artifactRepository.listByAgent(agentName);
    assert.deepEqual(
      byAgent.filter((a) => a.artifactId.endsWith(suffix)).map((a) => a.artifactId),
      [artifactIds[2], artifactIds[1], artifactIds[0]],
      "the agent index returns every artifact, newest first",
    );

    const byOwner = await artifactRepository.listByOwner("it@example.com");
    assert.deepEqual(
      byOwner.filter((a) => a.artifactId.endsWith(suffix)).map((a) => a.artifactId),
      [artifactIds[1], artifactIds[0]],
      "the owner index omits the Slack run, whose actor names no mailbox",
    );

    const images = await artifactRepository.listByAgent(agentName, { kind: "image" });
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
    const firstPage = await artifactRepository.listByAgent(agentName, { limit: 2 });
    assert.deepEqual(
      firstPage.map((a) => a.artifactId),
      [artifactIds[2], artifactIds[1]],
      "a page of two returns the two newest",
    );
    const secondPage = await artifactRepository.listByAgent(agentName, {
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
    // Its own agent, so the ordering the assertions above pin is untouched.
    const filterAgent = `it-filter-${suffix}`;
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
        agentName: filterAgent,
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
      agentName: filterAgent,
      actor: { kind: "user" as const, id: "it@example.com" },
      createdAt: new Date(filterBase).toISOString(),
    });
    artifactFixtures.push(buriedId);
    assert.deepEqual(
      (await artifactRepository.listByAgent(filterAgent, { limit: 24, kind: "document" })).map(
        (a) => a.artifactId,
      ),
      [buriedId],
      "a document behind forty images is found, not paged past",
    );
    assert.deepEqual(
      (
        await artifactRepository.listByAgent(filterAgent, {
          limit: 5,
          kind: "image",
          source: "generated",
        })
      ).length,
      5,
      "a filtered page is full at the limit, not thinned by the filter",
    );
    assert.deepEqual(
      await artifactRepository.listByAgent(filterAgent, { kind: "document", source: "generated" }),
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
          pk: keys.artifactAgentPartition(filterAgent),
          filter: { byteSize: "1024" },
        })
      ).map((row) => row.artifactId),
      [buriedId],
      "a numeric attribute is matched by its text rendering",
    );
    assert.deepEqual(
      await queryItems({
        index: "GSI1",
        pk: keys.artifactAgentPartition(filterAgent),
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
    pass("artifacts: agent + owner indexes, sparse owner index, kind filter, idempotent delete");

    // ---------- transact lock modes (a checked key does not serialise) ----------
    // A `check` op asserts something elsewhere is still live; the exclusive
    // lock it used to take made every usage row, trace and agent write in a
    // agent queue on that agent's one META row. The two directions that
    // matter: a shared holder must not block a checker, and an exclusive one
    // must still block it — that is the delete the check exists to catch.
    {
      const { transact, conditions } = await import("@/infrastructure/db/store");
      const { getPool } = await import("@/infrastructure/db/client");
      const { keys } = await import("@/infrastructure/db/keys");
      const agentKey = keys.agent(agentName);
      const probeKey = keys.trace(`lock-probe-${suffix}`);
      const probe = { ...probeKey, entityType: "TRACE", agentName, createdAt: now };
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
          [agentKey.PK, agentKey.SK],
        );
        await holder.query("SELECT data FROM items WHERE pk = $1 AND sk = $2 FOR SHARE", [
          agentKey.PK,
          agentKey.SK,
        ]);
        assert.equal(
          await waited(
            transact([
              { kind: "check", key: agentKey, condition: conditions.exists },
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
          { kind: "update", key: agentKey, patch: (row) => ({ ...(row ?? {}) }) },
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
      const target = (await agentRepository.get(agentName))!;
      const config = { agentName, userEmail: target.ownerEmail, revision: 1, enabled: true, model: "integration/asr",
        retention: { unit: "months" as const, value: 3, timezone: "UTC" }, maxActive: 1, maxPerOccurrence: 1,
        postprocess: { agentName }, updatedAt: now };
      assert.equal(await configs.save(config, 0), true);
      const before = (await agentRepository.get(agentName))!;
      assert.deepEqual(before.configuration, target.configuration, "saving a recipe preserves Agent settings");
      assert.equal(await configs.save({ ...config, userEmail: "other@example.test", revision: 2 }, 1), false);
      assert.equal(await configs.save({ ...config, postprocess: { agentName: "missing-target" }, revision: 2 }, 1), false);
      assert.equal((await configs.get(agentName))?.revision, 1);
      const raced = await Promise.all([
        configs.save({ ...config, maxActive: 2, revision: 2 }, 1),
        configs.save({ ...config, maxActive: 3, revision: 2 }, 1),
      ]);
      assert.equal(raced.filter(Boolean).length, 1, "one concurrent recipe update wins");
      pass("audio configuration: current target checks and concurrent recipe CAS");
    }

    // ---------- durable usage receipts ----------
    {
      const event = { idempotencyKey: `asr-${suffix}`, agentName, date: today, model: "asr-integration",
        calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.01, actor: "user:audio-integration@example.com" };
      try {
        await Promise.all(Array.from({ length: 8 }, () => usageRepository.record(event)));
        assert.equal((await usageRepository.getDay(agentName, today))?.calls["asr-integration"], 1);
        // PostgreSQL JSONB reorders object keys; replay compares values, not serialized order.
        await usageRepository.record(event);
        await assert.rejects(usageRepository.record({ ...event, costUsd: 2 }));
        assert.equal((await usageRepository.getDay(agentName, today))?.costUsd["asr-integration"], 0.01);
        pass("usage receipts: concurrent replay bills once and rejects conflicting payloads");
      } finally {
        const { deleteItem } = await import("@/infrastructure/db/store");
        await deleteItem(dbKeys.usageMember("audio-integration@example.com", today, agentName));
      }
    }

    // ---------- source inventory (completion recovery + deletion fencing) ----------
    {
      const { sourceFileRepository: files } = await import("@/infrastructure/db/repositories/sourceFileRepository");
      const { deleteItem } = await import("@/infrastructure/db/store");
      const id = `source-${suffix}`;
      try {
        const pending = await files.create({ id, agentName, userEmail: "integration@example.com",
          filename: "sample.mp3", mimeType: "audio/mpeg", retention: { unit: "months", value: 3, timezone: "Asia/Seoul" },
          revision: 1, status: "pending", createdAt: now, retireAt: now });
        const competing = await Promise.all([
          files.finish(pending, { storedAt: now, retireAt: now, checksum: "sha256", byteSize: 3 }),
          files.finish(pending, { storedAt: now, retireAt: now, checksum: "sha256", byteSize: 3 }),
        ]);
        assert.equal(competing.filter(Boolean).length, 1);
        assert.equal(await files.get(`${agentName}-other`, id), null);
        const ready = (await files.get(agentName, id))!;
        assert.equal(ready.status, "ready");
        const deleting = await files.markDeleting(ready, now);
        assert.ok(deleting);
        assert.equal(await files.finish(pending, { storedAt: now, retireAt: now, checksum: "late", byteSize: 3 }), null);
        assert.equal(await files.markDeleted(deleting, now), true);
        assert.equal((await files.get(agentName, id))?.status, "deleted");
        assert.equal((await files.expired(now, 100)).some((file) => file.id === id), false);
        pass("source inventory: atomic completion, agent isolation and deletion fencing");
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
        const pending = await files.create({ id, agentName, userEmail: "integration@example.com",
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
        agentName, userEmail: "integration@example.com", source: { kind: "file" as const, fileId: "audio-file" },
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
        jobs.claim(agentName, job.id, now, "worker-a", leaseUntil),
        jobs.claim(agentName, job.id, now, "worker-b", leaseUntil),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find((value) => value !== null)!;
      const second = await jobs.claim(agentName, job.id, reclaimedAt, "worker-c", nextUntil);
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
      assert.equal(next.status, "accepted", "terminal job releases its durable agent slot");
      assert.equal(await jobs.cancel(agentName, "audio-next", 1, reclaimedAt), true);
      pass("audio jobs: concurrent admission, lease fencing, durable dedup and slot release");

      const queued = await Promise.all(Array.from({ length: 3 }, (_, index) => jobs.submit({ ...input, sourceKey: `queued-source-${index}` }, {
        id: `queued-audio-${index}`, now, occurrence: "queued-hour", maxActive: 3, maxPerOccurrence: 3,
      })));
      assert.equal(queued.filter((result) => result.status === "accepted").length, 3);
      const queue = await getItem(dbKeys.audioJobSlots(agentName));
      const order = queue!.jobIds as string[];
      for (const id of order) {
        const competing = await Promise.all(order.map((candidate) => jobs.claim(agentName, candidate, now, `worker-${candidate}`, leaseUntil)));
        const claimed = competing.filter((job) => job !== null);
        assert.equal(claimed.length, 1, "only the agent queue head can be claimed across workers");
        assert.equal(claimed[0]!.id, id, "execution follows transactional admission order");
        assert.ok(await jobs.checkpoint(claimed[0]!, { status: "completed", stage: "cleaning", dueAt: now }, now));
      }
      assert.deepEqual((await getItem(dbKeys.audioJobSlots(agentName)))!.jobIds, []);
    pass("audio jobs: concurrent queue admission and serial FIFO processing across workers");
    }

    // ---------- Agent recommendation admission across concurrent callers ----------
    {
      const { createAgentRecommendationQuota, MAX_AGENT_RECOMMENDATIONS_PER_MINUTE } =
        await import("@/infrastructure/db/repositories/agentRecommendationQuota");
      const { deleteItem } = await import("@/infrastructure/db/store");
      const email = `recommend-${suffix}@example.com`;
      const quota = createAgentRecommendationQuota(() => new Date(now));
      try {
        const admissions = await Promise.all(Array.from(
          { length: MAX_AGENT_RECOMMENDATIONS_PER_MINUTE + 1 },
          () => quota.admit(email),
        ));
        assert.equal(admissions.filter(value => value === undefined).length, MAX_AGENT_RECOMMENDATIONS_PER_MINUTE);
        assert.equal(admissions.filter(value => value !== undefined).length, 1);
        assert.equal((await getItem(dbKeys.agentRecommendationQuota(email, today)))?.dayCount, MAX_AGENT_RECOMMENDATIONS_PER_MINUTE);
        pass("Agent recommendation quota: concurrent admission is exact");
      } finally {
        await deleteItem(dbKeys.agentRecommendationQuota(email, today));
      }
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
    assert.equal(await runSlotRepository.renew(slotActor, firstSlot, nowSeconds + 900), true);
    await runSlotRepository.release(slotActor, firstSlot!);
    assert.equal(await runSlotRepository.renew(slotActor, firstSlot, nowSeconds + 1200), false, "released holders cannot renew");
    assert.ok(
      await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600),
      "a released slot is reusable",
    );
    // An instance that died holds a slot only until its lease runs out.
    const expiredActor = `user:expired-${suffix}@example.com`;
    const expiredSlot = await runSlotRepository.acquire(expiredActor, 1, nowSeconds - 1);
    assert.ok(expiredSlot);
    assert.equal(await runSlotRepository.renew(expiredActor, expiredSlot, nowSeconds + 600), false, "expired holders cannot renew");
    assert.ok(
      await runSlotRepository.acquire(expiredActor, 1, nowSeconds + 600),
      "an expired lease is reclaimable",
    );
    pass("concurrency slots: exact limit, owned renewal, release and lease reclaim");

    // ---------- Agent: collected completion ----------
    const runResult = await collectAgentRun(executionDeps, {
      agent,
      configuration,
      messages: [{ role: "user", content: "Hello world" }],
    });
    assert.equal(runResult.content, "streamed answer", "collectAgentRun content");
    assert.ok(runResult.usage.inputTokens > 0, "collectAgentRun usage recorded");
    pass("collectAgentRun collected Agent via mock LLM");

    // ---------- engine: agent loop with Skill tool ----------
    const chunks: Array<{ delta?: { content?: string }; toolResult?: unknown; error?: string }> =
      [];
    for await (const chunk of executeAgent(executionDeps, {
      agent,
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
      const base = { agent, configuration: approvalConfiguration, actor: { kind: "user" as const, id: owner }, conversation: { surface: "chat" as const, id: sessionId } };
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
    await agentRepository.delete(agentName);
    assert.equal(await agentRepository.get(agentName), null, "agent deleted");
    await assert.rejects(
      () => agentRepository.create(agent),
      "a deleted agent name remains reserved by its tombstone",
    );
    assert.equal(await workspacePolicyRepository.get(agentName), null, "Workspace policy deleted");
    assert.equal(await workspaceRepositoryCreationStore.get(agentName, repositoryRequest.repository), null, "Repository creation receipt deleted");
    await assert.rejects(workspacePolicyRepository.put(workspacePolicy, null), "deleted agent cannot regain Workspace access");
    assert.equal(
      (await usageRepository.listByAgent(agentName, today, today)).length,
      0,
      "usage rows deleted",
    );
    assert.equal(
      (await transcriptRepository.recent(agentName, `telegram:${suffix}`, 5)).length,
      0,
      "transcript turns deleted with the agent",
    );
    pass("agent cascade delete (name tombstone + settings + usage + transcript)");
  } finally {
    // cleanup non-cascading fixtures
    await skillRepository.delete("integration-skill").catch(() => {});
    await mcpRepository.delete(`it-mcp-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-list-ordinary-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-list-workspace-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-swept-${suffix}`).catch(() => {});
    await import("@/infrastructure/db/client")
      .then(({ withTransaction }) =>
        withTransaction(async (client) => {
          await client.query(`DROP TABLE IF EXISTS ${vectorTable}`);
          await client.query(`DELETE FROM "user" WHERE "id" = $1`, [integrationMemberId]);
        }),
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
        await deleteItem(keys.usageMember(fixture.email, fixture.date, fixture.agent)).catch(
          () => {},
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      mock.close((error) => (error ? reject(error) : resolve()));
    });
    await restoreModelSettings?.();
    restoreModelSettings = undefined;
    const { closePool } = await import("@/infrastructure/db/client");
    await closePool();
  }

  console.log(`\n${results.length} integration checks passed`);
}

main().catch(async (error) => {
  await restoreModelSettings?.();
  console.error("INTEGRATION FAILURE:", error);
  process.exit(1);
});
