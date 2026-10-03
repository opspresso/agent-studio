import { assertLocalDatabase } from "./local-database";
import { withCheckLifecycle, type RegisterCheckCleanup } from "./check-lifecycle";
import { utcDay } from "@/shared/date";

/**
 * Integration checks against local PostgreSQL and mock provider transports.
 * Covers schema/auth, repository transactions and SDK Agent execution,
 * routing, billing, persistent Sessions and approval resume.
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
process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

async function main() {
  const checksPassed = await withCheckLifecycle(runChecks);
  console.log(`\n${checksPassed} integration checks passed`);
}

async function runChecks(cleanup: RegisterCheckCleanup) {
  const { closePool, withTransaction } = await import("@/infrastructure/db/client");
  cleanup(closePool);
  const { auditRepository } = await import("@/infrastructure/db/repositories/auditRepository");
  const { keys: dbKeys } = await import("@/infrastructure/db/keys");
  const { deleteItem, getItem } = await import("@/infrastructure/db/store");
  const auditKeys = new Map<string, ReturnType<typeof dbKeys.auditEvent>>();
  const appendAudit = auditRepository.append;
  auditRepository.append = async event => {
    const key = dbKeys.auditEvent(utcDay(new Date(event.createdAt)), event.createdAt, event.eventId);
    auditKeys.set(JSON.stringify(key), key);
    await appendAudit(event);
  };
  cleanup(() => { auditRepository.append = appendAudit; });
  // Register before other owners: their releases can also append audit records.
  cleanup(() => withCheckLifecycle(async remove => {
    for (const key of auditKeys.values()) remove(() => deleteItem(key));
  }));
  // ---------- mock LLM server ----------
  const llmCalls: Array<Record<string, unknown>> = [];
  const decisionCalls: Array<Record<string, unknown>> = [];
  let onNextRoutingRequest: (() => Promise<void>) | undefined;
  let mockFailure: unknown;
  const mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    const respond = async () => {
      const body = JSON.parse(raw) as {
        stream?: boolean;
        model?: string;
        max_completion_tokens?: number;
        questions?: Record<string, { criteria: Record<string, string> }>;
        messages: Array<{ role: string; content?: unknown }>;
      };
      if (req.url?.endsWith("/systemone")) {
        decisionCalls.push(body);
        const criteria = body.questions!.selection!.criteria;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answers: { selection: { type: "choice", choice: "fast", confidence: 1,
          probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === "fast" ? 1 : 0])) } },
          usage: { input_tokens: 20, output_tokens: 2, cost: 0.001 } }));
        return;
      }
      llmCalls.push(body);
      if (body.stream && JSON.stringify(body.messages).includes("integration-empty-at-cap")) {
        const cap=body.max_completion_tokens!;
        res.writeHead(200,{"Content-Type":"text/event-stream"});
        for(const data of [
          {id:"empty-at-cap",choices:[{index:0,delta:{reasoning_content:"Still solving"},finish_reason:null}]},
          {id:"empty-at-cap",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:cap,total_tokens:20+cap,completion_tokens_details:{reasoning_tokens:cap},cost:0.002}},
        ]) res.write(`data: ${JSON.stringify(data)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      const wantsModelTask = !hasToolResult && JSON.stringify(body.messages).includes("route model task") && JSON.stringify(body).includes('"ModelTask"');
      const wantsSkill =
        !hasToolResult &&
        JSON.stringify(body.messages).includes("integration-skill") &&
        JSON.stringify(body).includes('"tools"');
      if (wantsModelTask && onNextRoutingRequest) {
        const change = onNextRoutingRequest;
        onNextRoutingRequest = undefined;
        await change();
      }

      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (wantsSkill || wantsModelTask) {
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
                      function: wantsModelTask
                        ? { name: "ModelTask", arguments: JSON.stringify({ purpose: "summary", prompt: "Summarize ROUTING_PRIVATE_SOURCE with alice@example.test", model: null, image_ids: [] }) }
                        : { name: "Skill", arguments: '{"skill_name":"integration-skill"}' },
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
            usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.002 },
          }),
        );
      }
    };
    const failed = (error: unknown) => {
      if (mockFailure === undefined) mockFailure = error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    };
    req.on("error", failed);
    req.on("end", () => { void respond().catch(failed); });
  });
  cleanup(async () => {
    if (mock.listening) {
      await new Promise<void>((resolve, reject) => {
        mock.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    mock.once("error", onError);
    mock.listen(0, "127.0.0.1", () => {
      mock.off("error", onError);
      resolve();
    });
  });
  const address = mock.address();
  assert.ok(address && typeof address !== "string", "mock listener address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { settingsRepository } = await import("@/infrastructure/db/repositories/settingsRepository");
  const { registeredModelConfig } = await import("@/domain/llm/providerModels");
  const { replaceModelRegistry } = await import("@/domain/llm/models");
  const previousSettings = await settingsRepository.get();
  cleanup(async () => {
    if (previousSettings) await settingsRepository.update(() => previousSettings);
    else {
      const { deleteItem } = await import("@/infrastructure/db/store");
      const { keys } = await import("@/infrastructure/db/keys");
      await deleteItem(keys.settings());
    }
  });
  const registeredModels = [...["openai/gpt-5-mini", "integration/model", "integration/fast"].map(id => ({
    id, provider: id.split("/")[0]!, wireId: id.split("/")[1]!, displayName: id, type: "text" as const,
    contextWindow: 128000, maxTokens: 4000,
    capabilities: { tools: true, structuredOutput: true, imageInput: false, reasoning: false },
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  })), { id: "integration/jev", provider: "integration", wireId: "jev", displayName: "Jev fixture", type: "decision" as const,
    contextWindow: 32000, maxTokens: 28800, capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false },
    pricing: { inputPer1M: 0, outputPer1M: 0 } }];
  const { encryptSecret: encryptProviderKey } = await import("@/infrastructure/crypto/secretEncryption");
  const { llmProviderApiKeyContext } = await import("@/domain/security/secretContext");
  await settingsRepository.update(current => ({ ...current, registeredModels, decisionModel: "integration/jev",
    llmProviders: ["openai", "integration"].map(name => ({ name, kind: "selfhosted" as const, baseUrl,
      apiKey: encryptProviderKey("test", llmProviderApiKeyContext(name, baseUrl)) })), updatedAt: new Date().toISOString() }));
  replaceModelRegistry(registeredModels.map(model => registeredModelConfig(model, "selfhosted")));

  const { checkSchemaBaseline } = await import("./schema-baseline-check");
  await checkSchemaBaseline();
  const { checkRuntimeSessions } = await import("./runtime-session-check");
  await checkRuntimeSessions();
  const { checkSessionExpiry } = await import("./session-expiry-check");
  await checkSessionExpiry();
  const { checkWorkspaces } = await import("./workspace-check");
  await checkWorkspaces();
  const { checkMcpRefreshCoordination } = await import("./mcp-refresh-check");
  await checkMcpRefreshCoordination();
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
  const { listUserMcpConnections } = await import("@/application/mcp/listConnections");
  const { mcpOAuthStateRepository } = await import(
    "@/infrastructure/db/repositories/mcpOAuthStateRepository"
  );
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const { memberRepository } = await import("@/infrastructure/db/repositories/memberRepository");
  const { createPgVectorStore } = await import("@/infrastructure/vector/pgVectorStore");
  const { runSlotRepository } = await import("@/infrastructure/db/repositories/runSlotRepository");
  const { triggerRepository } = await import("@/infrastructure/db/repositories/triggerRepository");
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

  const suffix = Date.now().toString(36);
  const now = new Date().toISOString();
  const executionUser = { userId: "execution-" + suffix, email: "it@example.com" };
  const executionIdentity = { user: executionUser, actor: { kind: "user" as const, id: executionUser.email } };
  const today = now.slice(0, 10);
  const results: string[] = [];
  const pass = (label: string) => {
    results.push(`PASS ${label}`);
    console.log(`PASS ${label}`);
  };

  const agentName = `it-proj-${suffix}`;
  const integrationMemberId = `it-member-${suffix}`;
  const integrationMemberEmail = `${integrationMemberId}@example.com`;
  const vectorTable = `it_vectors_${suffix}`;
  const registerChat = (chatId: string) => cleanup(async () => {
    // Delete only owned fixture chats that were created; deletion fences late writes.
    if (await getItem(dbKeys.chat(chatId))) await chatRepository.delete(chatId);
  });

  try {
    const { checkManagedMcpTransport } = await import("./managed-mcp-check");
    await checkManagedMcpTransport();
    pass("managed MCP provision, registration and real loopback transport");
    pass("OAuth rotating refresh: two independent processes share one PostgreSQL claim and provider effect");

    // ---------- agent + current settings ----------
    await agentRepository.create({
      name: agentName,
      displayName: "Integration Agent",
      description: "integration test",
      ownerEmail: "it@example.com",
      createdAt: now,
      updatedAt: now,
    });
    let agentNeedsCleanup = true;
    cleanup(async () => {
      if (agentNeedsCleanup) await agentRepository.delete(agentName);
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
    const repositoryAttempts = await Promise.allSettled([createRepository.create(agentName, repositoryRequest, { userId: integrationMemberId, email: "it@example.com" }), createRepository.create(agentName, repositoryRequest, { userId: integrationMemberId, email: "it@example.com" })]);
    assert.ok(repositoryAttempts.some(result => result.status === "fulfilled"));
    assert.equal(repositoryCreates, 1, "one external create across concurrent requests");
    assert.deepEqual((await workspacePolicyRepository.get(agentName))?.rules?.repositories, [repositoryRequest.repository]);
    assert.equal((await workspaceRepositoryCreationStore.get(agentName, repositoryRequest.repository))?.status, "created");
    assert.equal((await createRepository.create(agentName, repositoryRequest, { userId: integrationMemberId, email: "it@example.com" })).reused, true);
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
    cleanup(() => skillRepository.delete("integration-skill"));
    await skillRepository.put({
      name: "integration-skill",
      description: "Integration testing behavior",
      content: "# Skill\nAlways answer concisely.",
      source: "github:integration/plugins#integration",
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
      [{ name: "integration-skill", description: "Integration testing behavior", source: "github:integration/plugins#integration" }],
      "skill describe returns the description and omits what is not there",
    );
    pass("skill describe projected SQL read");

    const { capabilityVisibilityUseCases } = await import("@/lib/container");
    const previousVisibility = (await settingsRepository.get())?.capabilityVisibility;
    await Promise.all([
      capabilityVisibilityUseCases.update([{ kind: "plugins", name: "integration", enabled: false }], "first@example.test"),
      capabilityVisibilityUseCases.update([{ kind: "skills", name: "integration-skill", enabled: false }], "second@example.test"),
    ]);
    const concurrentVisibility = (await settingsRepository.get())?.capabilityVisibility;
    assert.ok(concurrentVisibility?.plugins.includes("integration"), "first administrator's change survives");
    assert.ok(concurrentVisibility?.skills.includes("integration-skill"), "second administrator's change survives");
    await settingsRepository.update(current => ({ ...current!, capabilityVisibility: previousVisibility }));
    pass("capability usage: concurrent administrator changes merge atomically");

    // ---------- pgvector adapter ----------
    cleanup(() => withTransaction(async client => { await client.query(`DROP TABLE IF EXISTS ${vectorTable}`); }));
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
    cleanup(() => withTransaction(async client => { await client.query(`DELETE FROM "user" WHERE "id" = $1`, [integrationMemberId]); }));
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
    const { agentCredentialRepository } = await import("@/infrastructure/db/repositories/agentCredentialRepository");
    const { createAgentCredentialUseCases } = await import("@/application/auth/agentCredentialUseCases");
    const { secretCipher } = await import("@/infrastructure/crypto/secretCipher");
    const { randomUUID } = await import("node:crypto");
    const personalApi = createAgentCredentialUseCases({ purpose: "api", agents: agentRepository, tokens: agentCredentialRepository,
      members: memberRepository, cipher: secretCipher, now: () => new Date(now), newId: randomUUID });
    const issuedToken = await personalApi.generate(agentName, integrationMemberId);
    assert.deepEqual(await personalApi.verify(agentName, issuedToken.token), { userId: integrationMemberId, email: integrationMemberEmail, credentialId: issuedToken.credentialId });
    const concurrentTokens = await Promise.allSettled([personalApi.generate(agentName, integrationMemberId), personalApi.generate(agentName, integrationMemberId)]);
    assert.equal(concurrentTokens.filter(result => result.status === "fulfilled").length, 1, "only one concurrent personal rotation succeeds");
    assert.equal(await personalApi.verify(agentName, issuedToken.token), null, "previous credential is revoked atomically");
    const tokenWinner = concurrentTokens.find(result => result.status === "fulfilled")! as PromiseFulfilledResult<Awaited<ReturnType<typeof personalApi.generate>>>;
    assert.deepEqual(await personalApi.verify(agentName, tokenWinner.value.token), { userId: integrationMemberId, email: integrationMemberEmail, credentialId: tokenWinner.value.credentialId });
    await personalApi.revoke(agentName, integrationMemberId);
    assert.equal(await personalApi.verify(agentName, tokenWinner.value.token), null, "personal revocation removes the credential and reference together");
    pass("personal API credentials: stable issuer, encrypted scope, PostgreSQL rotation CAS and atomic revocation");
    const personalWebhook = createAgentCredentialUseCases({ purpose: "webhook", agents: agentRepository, tokens: agentCredentialRepository,
      members: memberRepository, cipher: secretCipher, now: () => new Date(now), newId: randomUUID });
    const [apiCredential, webhookCredential] = await Promise.all([
      personalApi.generate(agentName, integrationMemberId), personalWebhook.generate(agentName, integrationMemberId),
    ]);
    const initializedWebhook = await triggerRepository.get(agentName, "webhook");
    assert.equal(initializedWebhook?.kind, "webhook");
    assert.equal(initializedWebhook?.allowConcurrent, false);
    assert.ok(!Object.hasOwn(initializedWebhook!, "enabled"));
    assert.equal(await personalApi.verify(agentName, webhookCredential.token), null);
    assert.equal(await personalWebhook.verify(agentName, apiCredential.token), null);
    const signedBody = '{"event":"integration"}';
    const { createHmac } = await import("node:crypto");
    const signature = "sha256=" + createHmac("sha256", webhookCredential.token).update(signedBody).digest("hex");
    assert.deepEqual(await personalWebhook.verifySignature(agentName, webhookCredential.credentialId, signedBody, signature),
      { userId: integrationMemberId, email: integrationMemberEmail, credentialId: webhookCredential.credentialId });
    await personalWebhook.revoke(agentName, integrationMemberId);
    assert.deepEqual(await triggerRepository.get(agentName, "webhook"), initializedWebhook);
    assert.equal(await personalWebhook.authorize(agentName, webhookCredential.credentialId, integrationMemberId), null);
    assert.ok(await personalApi.authorize(agentName, apiCredential.credentialId, integrationMemberId));
    await personalApi.revoke(agentName, integrationMemberId);
    pass("personal credential purposes: concurrent isolated issuance, signed Webhook identity and independent revocation");
    const { messagingIdentityRepository } = await import("@/infrastructure/db/repositories/messagingIdentityRepository");
    const { createMessagingIdentityUseCases } = await import("@/application/auth/messagingIdentityUseCases");
    const messaging = createMessagingIdentityUseCases({ identities: messagingIdentityRepository,
      agents: agentRepository, members: memberRepository, now: () => new Date(now) });
    const messagingCode = await messaging.issue(agentName, "slack", integrationMemberId);
    const messagingSubject = { agentName, platform: "slack" as const, realm: "integration-workspace", externalId: "sender" };
    const messagingClaims = await Promise.allSettled([
      messaging.connect(messagingSubject, messagingCode.code),
      messaging.connect({ ...messagingSubject, externalId: "other-sender" }, messagingCode.code),
    ]);
    assert.equal(messagingClaims.filter(result => result.status === "fulfilled").length, 1);
    const linkedIdentities = await messaging.list(integrationMemberId);
    assert.equal(linkedIdentities.length, 1);
    assert.deepEqual(await messaging.resolve(linkedIdentities[0]!), { userId: integrationMemberId, email: integrationMemberEmail });
    await memberRepository.setTier(integrationMemberId, "guest");
    await assert.rejects(messaging.resolve(linkedIdentities[0]!), /member access/);
    await messaging.unlink(linkedIdentities[0]!, integrationMemberId);
    assert.equal(await messaging.resolve(linkedIdentities[0]!), null);
    await memberRepository.setTier(integrationMemberId, "member");
    pass("messaging identity: PostgreSQL one-time claim, stable issuer, current membership and personal unlink");
    const scheduleAgentName = `it-schedule-${suffix}`;
    cleanup(() => agentRepository.delete(scheduleAgentName));
    await agentRepository.create({ name: scheduleAgentName, displayName: "Schedule identity check", description: "",
      ownerEmail: integrationMemberEmail, createdAt: now, updatedAt: now });
    const { createTriggerUseCases } = await import("@/application/trigger/triggerUseCases");
    const schedules = createTriggerUseCases({ agents: agentRepository, triggers: triggerRepository, members: memberRepository });
    const registeredSchedule = await schedules.create(scheduleAgentName, { triggerId: "daily", kind: "schedule", cron: "0 9 * * *", timezone: "UTC" }, integrationMemberId);
    assert.deepEqual(registeredSchedule.createdBy, { userId: integrationMemberId, email: integrationMemberEmail });
    await schedules.update(scheduleAgentName, "daily", { message: "Registered user's task" }, integrationMemberEmail);
    const storedSchedule = await triggerRepository.get(scheduleAgentName, "daily");
    assert.equal(storedSchedule?.kind, "schedule");
    assert.deepEqual(storedSchedule?.kind === "schedule" && storedSchedule.createdBy, registeredSchedule.createdBy);
    const { resolveRunUser } = await import("@/application/auth/resolveRunUser");
    await memberRepository.setTier(integrationMemberId, "guest");
    await assert.rejects(resolveRunUser({ agents: agentRepository, members: memberRepository }, scheduleAgentName, integrationMemberId), /member access/);
    await memberRepository.setTier(integrationMemberId, "member");
    pass("schedule registration: authenticated stable creator, PostgreSQL round-trip, immutable identity and current member access");
    const { checkMemberTiers } = await import("./member-tiers-check");
    await checkMemberTiers(integrationMemberId, integrationMemberEmail);
    pass("member tier catalog, assignment/deletion serialization and shared rollback");

    // ---------- MCP encrypted headers ----------
    const serverName = `it-mcp-${suffix}`;
    const mcpHeaders = encryptHeaders(
      { Authorization: "Bearer secret-token" },
      mcpHeadersContext(serverName),
    );
    const sourceOutputs = [{ tool: "get_file", namespace: "plaud", urlPath: ["presigned_url"],
      idPath: ["id"], namePath: ["name"], mimeType: "audio/mpeg", refreshArgument: "file_id" }];
    cleanup(() => mcpRepository.delete(serverName));
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
      userInfoEndpoint: "https://auth.example.com/userinfo",
      userInfoScopes: ["openid", "email"],
      accountLookup: { kind: "mcp" as const, toolName: "who_am_i", arguments: {}, labelPath: "/email" },
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

    // ---------- personal MCP OAuth connection + in-flight state ----------
    const { deletePartition } = await import("@/infrastructure/db/store");
    cleanup(() => deletePartition(dbKeys.mcpUserPartition(agentName)));
    await mcpConnectionRepository.put({
      userId: agentName,
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
      connectedAccount: { provider: "github", label: "connected-account" },
      connectedAt: now,
      updatedAt: now,
    });
    const conn = await mcpConnectionRepository.get(agentName, serverName);
    assert.ok(conn, "mcp connection get");
    cleanup(() => deletePartition(dbKeys.mcpUserPartition(integrationMemberId)));
    await mcpConnectionRepository.put({ ...conn, userId: integrationMemberId, clientSecret: undefined, refreshToken: undefined,
      accessToken: encryptSecret("second-user-access", mcpConnectionSecretContext(integrationMemberId, serverName, "access-token")) });
    const otherUserConnection = (await mcpConnectionRepository.get(integrationMemberId, serverName))!;
    assert.equal(decryptSecret(otherUserConnection.accessToken!, mcpConnectionSecretContext(integrationMemberId, serverName, "access-token")), "second-user-access");
    assert.equal((await mcpConnectionRepository.get(agentName, serverName))?.accessToken, conn.accessToken, "another user's grant cannot replace this user's token");
    assert.equal((await listUserMcpConnections(mcpConnectionRepository, integrationMemberId)).length, 1, "personal grant listing is user-scoped");

    assert.deepEqual(conn.connectedAccount, { provider: "github", label: "connected-account" }, "provider account round-trip");
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
      (await listUserMcpConnections(mcpConnectionRepository, agentName)).length,
      1,
      "connection listed under its user partition",
    );

    // Compare-and-set on the grant revision: only the first writer can replace
    // the connection snapshot both callers read.
    const stored = conn.revision;
    assert.equal(await mcpConnectionRepository.updateAccount(conn, { provider: "notion", label: "verified-account" }, "lookup-contract-1"), true);
    assert.equal((await mcpConnectionRepository.get(agentName, serverName))?.revision, stored, "account display preserves the grant revision");
    assert.equal((await mcpConnectionRepository.get(agentName, serverName))?.accountLookupId, "lookup-contract-1", "lookup fingerprint survives JSONB round-trip");
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
    assert.deepEqual((await mcpConnectionRepository.get(agentName, serverName))?.connectedAccount,
      { provider: "notion", label: "verified-account" }, "token rotation preserves verified account display");
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
        userId: integrationMemberId,
        agentName,
        serverName,
        codeVerifier: encryptSecret("verifier", mcpOAuthStateContext(oauthState)),
        userEmail: "owner@example.com",
        issuer: "https://auth.example.com",
        redirectUri: "https://studio.example.test/api/mcps/oauth/callback",
        clientId: "integration-client",
        resource: "https://mcp.example.test",
        issParameterSupported: true,
        scopes: ["drive.file", "openid", "email"],
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
    assert.deepEqual(consumed?.scopes, ["drive.file", "openid", "email"], "requested identity scopes round-trip");
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
    registerChat(chatId);
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
    registerChat(workspaceListChatId);
    registerChat(ordinaryListChatId);
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
    registerChat(sweptChatId);
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
    const usageDelta = { userId: executionUser.userId, actor: "user:it@example.com",
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
    cleanup(() => deleteItem(dbKeys.usageMember(executionUser.userId, today, agentName)));
    cleanup(() => deleteItem(dbKeys.usageMember(executionUser.userId, new Date().toISOString().slice(0, 10), agentName)));
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

    // ---------- member day rows (one history per user ID, across actor kinds) ----------
    // A per-run address isolates atomic ADD counts from interrupted checks.
    const memberEmail = `it-member-${suffix}@example.com`;
    cleanup(() => deleteItem(dbKeys.usageMember(integrationMemberId, today, agentName)));
    await usageRepository.record({ ...usageDelta, userId: integrationMemberId, actor: `user:${memberEmail}` });
    await usageRepository.record({ ...usageDelta, userId: integrationMemberId, actor: `agent-token:${memberEmail}` });
    // The agent follows the date in the sort key, so this range only returns
    // anything if the upper bound reaches past an agent name — a plain
    // `BETWEEN DATE#from AND DATE#to` finds nothing at all.
    const memberDays = await usageRepository.listMemberDays(integrationMemberId, today, today);
    assert.equal(memberDays.length, 1, "one row per member per agent per day");
    assert.equal(
      memberDays[0]?.calls["openai/gpt-5-mini"],
      2,
      "personal token and interactive calls share the member history",
    );
    assert.equal(memberDays[0]?.agentName, agentName, "the row names where it was spent");
    assert.deepEqual(
      await usageRepository.listMemberDays(`nobody-${suffix}@example.com`, today, today),
      [],
      "an unknown member has no rows",
    );
    // The window the tier cap reads: month start through today.
    const capWindow = await usageRepository.listMemberDays(
      integrationMemberId,
      `${today.slice(0, 7)}-01`,
      today,
    );
    assert.equal(capWindow.length, 1, "the month-to-date window finds the day");
    pass("member day rows: per-agent split, cross-source accounting, range query");

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

    // ---------- webhook deduplication while the claim is retained ----------
    // Exercise the real PostgreSQL conditional write across repeated keys.
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
    pass("webhook deduplication: conditional claim, redelivery refused, scoped per trigger");

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
    // Check the SQL sort-key range and pre-limit status filter against real rows.
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

    // ---------- live trigger owner CAS and bounded expiry reads ----------
    const ownerTrigger = `it-owner-${suffix}`;
    const ownerNow = Date.now();
    const leasedRun = { agentName, triggerId: ownerTrigger, runId: "owned", status: "running" as const,
      startedAt: new Date(ownerNow - 3_600_000).toISOString(), runningLeaseToken: `owner-${suffix}`,
      runningLeaseUntil: new Date(ownerNow + 60_000).toISOString() };
    await triggerRepository.appendRun(leasedRun);
    assert.deepEqual(await triggerRepository.listRuns(agentName, ownerTrigger, 10), [leasedRun]);
    const renewedOwner = { ...leasedRun, runningLeaseUntil: new Date(ownerNow + 120_000).toISOString() };
    assert.equal(await triggerRepository.updateRunningRun(leasedRun, renewedOwner), true);
    const { runningLeaseToken: _ownerToken, runningLeaseUntil: _ownerDeadline, ...ownerIdentity } = leasedRun;
    void _ownerToken; void _ownerDeadline;
    assert.equal(await triggerRepository.updateRunningRun(leasedRun, { ...ownerIdentity, status: "failed", endedAt: now }), false,
      "a stale repair cannot settle a renewed execution owner");
    const expiredOwner = { ...leasedRun, runId: "expired-owner", runningLeaseToken: `expired-${suffix}`,
      runningLeaseUntil: new Date(ownerNow - 1).toISOString() };
    await triggerRepository.appendRun(expiredOwner);
    await triggerRepository.appendRun({ ...expiredOwner, runId: "expired-retention", startedAt: "1970-01-01T00:00:00.000Z" });
    assert.deepEqual(await triggerRepository.listRuns(agentName, ownerTrigger, 1, {
      status: "running", runningLeaseBefore: new Date(ownerNow).toISOString(),
    }), [expiredOwner], "retention and confirmed owner expiry filter before the running repair limit");
    const expiredIdentity = { ...ownerIdentity, runId: expiredOwner.runId };
    assert.equal(await triggerRepository.updateRunningRun(expiredOwner, { ...expiredIdentity, status: "succeeded", endedAt: now },
      { requireLiveOwner: true }), false, "an expired owner cannot record successful completion");
    assert.equal(await triggerRepository.updateRunningRun(expiredOwner, { ...expiredIdentity, status: "failed", endedAt: now }), true);
    assert.equal(await triggerRepository.updateRunningRun(renewedOwner, { ...ownerIdentity, status: "succeeded", endedAt: now },
      { requireLiveOwner: true }), true);
    assert.deepEqual(await triggerRepository.listRuns(agentName, ownerTrigger, 10, {
      status: "running", runningLeaseBefore: new Date(ownerNow + 180_000).toISOString(),
    }), [], "terminal writes remove the running owner index");
    const ownerHistory = await triggerRepository.listRuns(agentName, ownerTrigger, 10);
    assert.equal(ownerHistory.length, 2);
    assert.ok(ownerHistory.every(row => row.runningLeaseToken === undefined && row.runningLeaseUntil === undefined));
    pass("trigger execution owner: PostgreSQL renewal CAS, stale repair, live completion and expiry-before-limit");

    {
      const reviewTrigger = { agentName, triggerId: "webhook", kind: "webhook" as const,
        description: "PR reviews", allowConcurrent: true, createdAt: now, updatedAt: now,
        githubReview: { scope: "repositories" as const, repositories: ["example/agent"] } };
      await triggerRepository.put(reviewTrigger);
      assert.deepEqual((await triggerRepository.get(agentName, "webhook")), reviewTrigger);
      const review = { repository: "example/agent", number: 42, headSha: "a".repeat(40), status: "posted" as const,
        url: "https://github.com/example/agent/pull/42#pullrequestreview-1", workspaceUrl: "https://studio.example.test/chats/review-workspace" };
      await triggerRepository.finishRun({ ...recentRun, status: "succeeded", endedAt: now, review });
      assert.deepEqual((await triggerRepository.listRuns(agentName, triggerId, 1))[0]?.review, review);
      pass("PR review scope and publication receipt persist through PostgreSQL");
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
    const runningQueue = { ...queueIdentity, status: "running" as const, startedAt: new Date().toISOString(),
      runningLeaseToken: `queued-owner-${suffix}`, runningLeaseUntil: new Date(queueNow + 120_000).toISOString() };
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
    // Rows without a resolved owner email remain visible only in the Agent
    // index. Real PostgreSQL verifies that the sparse owner index omits them.
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
      cleanup(() => artifactRepository.delete(row.artifactId));
      await artifactRepository.put(row);
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
      "the owner index omits the fixture row with no resolved owner email",
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
      cleanup(() => artifactRepository.delete(id));
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
    }
    const buriedId = `it-art-buried-${suffix}`;
    cleanup(() => artifactRepository.delete(buriedId));
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

    // ---------- content deduplication (real PostgreSQL locks, aliases and deletion) ----------
    {
      const { storeArtifact } = await import("@/application/artifact/storeArtifact");
      const { artifactContentKey, contentChecksum } = await import("@/application/artifact/contentIdentity");
      const { artifactContentRepository: content } = await import("@/infrastructure/db/repositories/artifactContentRepository");
      const { createArtifactUseCases } = await import("@/application/artifact/artifactUseCases");
      const bytes = new TextEncoder().encode(`deduplication fixture ${suffix}`);
      const context = { agentName, ownerEmail: "it@example.com" };
      const input = { kind: "document" as const, source: "generated" as const, mimeType: "text/plain", bytes };
      let writes = 0;
      let deletes = 0;
      const blobs = new Map<string, Uint8Array>();
      const storage = { rows: artifactRepository, content, objects: {
        put: async (value: { key: string; bytes: Uint8Array }) => { writes++; blobs.set(value.key, value.bytes); },
        delete: async (key: string) => { deletes++; blobs.delete(key); }, sign: async () => "unused",
        read: async (key: string) => ({ bytes: blobs.get(key)!, mimeType: input.mimeType }),
      } };
      const contentKey = artifactContentKey({ ...context, ...input }, contentChecksum(bytes));
      cleanup(() => deleteItem(dbKeys.artifactContent(contentKey)));
      const ids = Array.from({ length: 12 }, (_, index) => `dedup-${index}-${suffix}`);
      for (const id of [...ids, `dedup-replacement-${suffix}`]) cleanup(() => artifactRepository.delete(id));
      const stored = await Promise.all(ids.map(artifactId => storeArtifact(storage, context, { ...input, artifactId })));
      assert.equal(writes, 1, "concurrent content saves perform one object write");
      assert.equal(new Set(stored.map(row => row.artifactId)).size, 1);
      for (const id of ids) assert.equal((await artifactRepository.get(id))?.artifactId, stored[0]!.artifactId);
      assert.equal((await artifactRepository.listByAgent(agentName, { limit: 100 })).filter(row => ids.includes(row.artifactId)).length, 1);
      const api = createArtifactUseCases(artifactRepository, storage.objects, agentRepository);
      await api.remove(ids[11]!, context.ownerEmail);
      assert.equal(deletes, 1);
      for (const id of ids) assert.equal(await artifactRepository.get(id), null);
      await storeArtifact(storage, context, { ...input, artifactId: `dedup-replacement-${suffix}` });
      assert.equal(writes, 2, "a deleted canonical file is not reused");
      const racingId = `dedup-race-${suffix}`;
      cleanup(() => artifactRepository.delete(racingId));
      const values = [new Uint8Array([1]), new Uint8Array([2])];
      for (const [index, body] of values.entries()) {
        cleanup(() => artifactRepository.delete(`dedup-race-verified-${index}-${suffix}`));
        cleanup(() => deleteItem(dbKeys.artifactContent(artifactContentKey({ ...context, ...input }, contentChecksum(body)))));
      }
      const raced = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => storeArtifact(storage, context,
        { ...input, artifactId: racingId, bytes: values[index % 2]! })));
      assert.ok(raced.some(result => result.status === "fulfilled"));
      assert.ok(raced.some(result => result.status === "rejected"));
      assert.equal(writes, 3, "different-content writes to the same artifact ID cannot overwrite the object");
      for (const [index, body] of values.entries()) {
        const saved = await storeArtifact(storage, context, { ...input, artifactId: `dedup-race-verified-${index}-${suffix}`, bytes: body });
        assert.deepEqual((await storage.objects.read(saved.key)).bytes, body, "content references return the matching bytes after an ID race");
      }
      pass("artifacts: SHA-256 deduplication across concurrent writes, reserved-ID aliases and canonical deletion");
    }

    // ---------- plugin sync lease fencing ----------
    const { checkPluginSyncLock } = await import("./plugin-sync-lock-check");
    await checkPluginSyncLock(suffix);
    pass("plugin sync lease: owned renewal, stale primitive refusal and atomic row-lock fencing");

    const { checkItemStoreConcurrency } = await import("./item-store-concurrency-check");
    await checkItemStoreConcurrency(suffix);
    pass("item store: unconditional writes respect absent-row transactions");

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
      cleanup(() => deleteItem(probeKey));
      const holder = await getPool().connect();
      let writer: Promise<void> | undefined;
      const waited = <T,>(promise: Promise<T>) =>
        Promise.race([
          promise.then(() => "done" as const),
          new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
        ]);
      await withCheckLifecycle(async release => {
        release(async () => { await writer; });
        release(() => holder.release(true));
        release(() => holder.query("ROLLBACK"));
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
      });
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
      const event = { userId: "fixture-user", idempotencyKey: `asr-${suffix}`, agentName, date: today, model: "asr-integration",
        calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.01, actor: "user:audio-integration@example.com" };
      cleanup(() => deleteItem(dbKeys.usageMember(event.userId, today, agentName)));
      cleanup(() => deleteItem(dbKeys.usageReceipt(event.userId, agentName, event.idempotencyKey)));
      await Promise.all(Array.from({ length: 8 }, () => usageRepository.record(event)));
      assert.equal((await usageRepository.getDay(agentName, today))?.calls["asr-integration"], 1);
      // PostgreSQL JSONB reorders object keys; replay compares values, not serialized order.
      await usageRepository.record(event);
      await assert.rejects(usageRepository.record({ ...event, costUsd: 2 }));
      assert.equal((await usageRepository.getDay(agentName, today))?.costUsd["asr-integration"], 0.01);
      pass("usage receipts: concurrent replay bills once and rejects conflicting payloads");
    }

    // ---------- native model admission and recoverable accounting ----------
    {
      const { workspaceModelCalls: calls } = await import("@/infrastructure/db/repositories/workspaceModelCalls");
      const { settleWorkspaceModelCall } = await import("@/application/workspace/modelGateway");
      const call = { id: `native-${suffix}`, workspaceId: `native-ws-${suffix}`, runId: `native-run-${suffix}`, startedAt: now };
      const event = { userId: executionUser.userId, idempotencyKey: call.id, agentName, date: today, model: "native-integration",
        calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.02, actor: "user:it@example.com" };
      cleanup(() => deleteItem(dbKeys.workspaceModelCall(call.workspaceId, call.runId)));
      cleanup(() => deleteItem(dbKeys.usageReceipt(event.userId, agentName, event.idempotencyKey)));
      const admitted = await Promise.all(Array.from({ length: 8 }, () => calls.begin(call)));
      assert.equal(admitted.filter(Boolean).length, 1, "one concurrent native request wins the run claim");
      await assert.rejects(calls.capture({ ...call, id: "different-request", usage: event }));
      await calls.capture({ ...call, usage: event });
      await usageRepository.record(event);
      // Resume after usage committed but the pending marker was not removed.
      assert.equal(await settleWorkspaceModelCall({ calls, usage: usageRepository }, call.workspaceId, call.runId), undefined);
      assert.equal(await calls.get(call.workspaceId, call.runId), null);
      assert.equal((await usageRepository.getDay(agentName, today))?.calls["native-integration"], 1);
      assert.equal(await settleWorkspaceModelCall({ calls, usage: usageRepository }, call.workspaceId, call.runId), undefined);
      pass("native model gateway: concurrent claim and durable once-only accounting recovery");
    }

    // ---------- source inventory (completion recovery + deletion fencing) ----------
    {
      const { sourceFileRepository: files } = await import("@/infrastructure/db/repositories/sourceFileRepository");
      const id = `source-${suffix}`;
      await withCheckLifecycle(async release => {
        release(() => deleteItem(dbKeys.sourceFile(id)));
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
      });
    }

    // ---------- private artifact publication/retirement fence ----------
    {
      const { sourceFileRepository: files } = await import("@/infrastructure/db/repositories/sourceFileRepository");
      const { registerSourceArtifact } = await import("@/application/artifact/storeArtifact");
      const id = `source-artifact-${suffix}`;
      await withCheckLifecycle(async release => {
        release(() => deleteItem(dbKeys.sourceFile(id)));
        release(() => artifactRepository.delete(id));
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
      });
    }

    // ---------- durable audio work (admission + worker fencing) ----------
    {
      const { audioJobRepository: jobs } = await import("@/infrastructure/db/repositories/audioJobRepository");
      const input = {
        agentName, userEmail: "integration@example.com", user: { userId: "integration-user", email: "integration@example.com" }, actor: { kind: "user" as const, id: "integration@example.com" }, source: { kind: "file" as const, fileId: "audio-file" },
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
      await withCheckLifecycle(async release => {
        release(() => deleteItem(dbKeys.agentRecommendationQuota(email, today)));
        const admissions = await Promise.all(Array.from(
          { length: MAX_AGENT_RECOMMENDATIONS_PER_MINUTE + 1 },
          () => quota.admit(email),
        ));
        assert.equal(admissions.filter(value => value === undefined).length, MAX_AGENT_RECOMMENDATIONS_PER_MINUTE);
        assert.equal(admissions.filter(value => value !== undefined).length, 1);
        assert.equal((await getItem(dbKeys.agentRecommendationQuota(email, today)))?.dayCount, MAX_AGENT_RECOMMENDATIONS_PER_MINUTE);
        pass("Agent recommendation quota: concurrent admission is exact");
      });
    }

    // ---------- concurrency slots (conditional claim + lease reclaim) ----------
    const slotActor = `user:slots-${suffix}@example.com`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const firstSlot = await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600);
    if (firstSlot) cleanup(() => runSlotRepository.release(slotActor, firstSlot));
    const secondSlot = await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600);
    if (secondSlot) cleanup(() => runSlotRepository.release(slotActor, secondSlot));
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
    const reusedSlot = await runSlotRepository.acquire(slotActor, 2, nowSeconds + 600);
    if (reusedSlot) cleanup(() => runSlotRepository.release(slotActor, reusedSlot));
    assert.ok(reusedSlot, "a released slot is reusable");
    // An instance that died holds a slot only until its lease runs out.
    const expiredActor = `user:expired-${suffix}@example.com`;
    const expiredSlot = await runSlotRepository.acquire(expiredActor, 1, nowSeconds - 1);
    if (expiredSlot) cleanup(() => runSlotRepository.release(expiredActor, expiredSlot));
    assert.ok(expiredSlot);
    assert.equal(await runSlotRepository.renew(expiredActor, expiredSlot, nowSeconds + 600), false, "expired holders cannot renew");
    const reclaimedSlot = await runSlotRepository.acquire(expiredActor, 1, nowSeconds + 600);
    if (reclaimedSlot) cleanup(() => runSlotRepository.release(expiredActor, reclaimedSlot));
    assert.ok(reclaimedSlot, "an expired lease is reclaimable");
    pass("concurrency slots: exact limit, owned renewal, release and lease reclaim");

    cleanup(() => withTransaction(async db => { await db.query('DELETE FROM "user" WHERE "id" = $1', [executionUser.userId]); }));
    await withTransaction(async db => { await db.query(
      'INSERT INTO "user" ("id", "name", "email", "emailVerified", "tier", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, $4, $5, $5)',
      [executionUser.userId, "Execution Test", executionUser.email, "member", now]); });
    // ---------- Agent: collected completion ----------
    const runResult = await collectAgentRun(executionDeps, { ...executionIdentity,
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
    for await (const chunk of executeAgent(executionDeps, { ...executionIdentity,
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

    // ---------- call-level routing: actual Jev/LLM transport and SQL persistence ----------
    {
      const { DEFAULT_CALL_ROUTING_POLICY } = await import("@/domain/llm/callRouting");
      const modelRouting = { ...DEFAULT_CALL_ROUTING_POLICY, tiers: { fast: "integration/fast",general:"integration/model" }, localOnly: true };
      const { modelRegistryUseCases } = await import("@/lib/container");
      const routingActor = `it-routing-${suffix}@example.test`;
      await modelRegistryUseCases.saveRouting(modelRouting, routingActor);
      assert.deepEqual((await modelRegistryUseCases.getRouting()).policy, modelRouting);
      const routedConfiguration = { ...configuration, parameters: { ...configuration.parameters, modelRouting: true } };
      const current = (await agentRepository.get(agentName))!;
      const routedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
      await agentRepository.update({ ...current, configuration: routedConfiguration, updatedAt: routedAt }, current.updatedAt);
      assert.equal((await agentRepository.get(agentName))?.configuration?.parameters.modelRouting, true);
      const before = llmCalls.length;
      const routed = [];
      const nextPolicy = { ...modelRouting, tiers: { fast: "integration/model",general:"integration/model" } };
      onNextRoutingRequest = async () => { await modelRegistryUseCases.saveRouting(nextPolicy, routingActor); };
      for await (const chunk of executeAgent(executionDeps, { ...executionIdentity,
        agent, configuration: routedConfiguration, messages: [{ role: "user", content: "route model task" }],
        actor: { kind: "user", id: "it@example.com" },
      })) routed.push(chunk);
      assert.ok(!routed.some((chunk) => chunk.error), "routed SDK loop completed");
      assert.deepEqual(llmCalls.slice(before).map((call) => call.model), ["fast", "fast", "fast"], "primary routes before the first inference and remains selected across tool turns");
      assert.equal(decisionCalls.length, 2, "primary and auxiliary choices actually use the System One adapter");
      const decision = decisionCalls[0]!;
      const decisionState = JSON.parse(decision.state as string);
      assert.deepEqual(Object.keys(decisionState).sort(), ["availableTiers", "budget", "promptSummary", "purpose", "requiredFeatures", "tierFacts"]);
      assert.deepEqual(decisionState.availableTiers, ["general", "fast"]);
      assert.ok(!JSON.stringify(decision).includes("ROUTING_PRIVATE_SOURCE"), "routing never sends the original prompt");
      assert.ok(!JSON.stringify(decision).includes("alice@example.test"), "routing never sends original personal data");
      assert.ok(routed.some((chunk) => chunk.toolResult?.name === "ModelTask" && chunk.toolResult.content === "plain answer"));
      assert.ok(routed.some((chunk) => chunk.usage?.model === "integration/jev" && chunk.usage.costUsd === 0.001));
      assert.ok(routed.some((chunk) => chunk.usage?.model === "integration/fast" && chunk.usage.costUsd === 0.002));
      const traceId = routed.find((chunk) => chunk.traceId)?.traceId;
      assert.ok(traceId);
      const trace = await executionDeps.traces!.get(traceId);
      assert.ok(trace?.spans.some((span) => span.name === "model-routing" && JSON.stringify(span.output).includes('"source":"jev"')), "routing reasons survived trace storage");
      assert.ok(trace?.spans.some((span) => span.name === "model-routing" && JSON.stringify(span.output).includes('"callKind":"primary"')), "primary selection survived trace storage");
      assert.ok(trace?.spans.some((span) => span.name === "model-routing" && JSON.stringify(span.output).includes('"decisionConfidence":1')), "decision certainty survived trace storage");
      assert.equal(typeof decisionState.tierFacts.fast.estimatedCostUsd,"number");
      assert.equal(decisionState.tierFacts.general.usesPrimaryModel,true);
      assert.ok(trace?.spans.some((span) => span.kind === "model" && span.name === "integration/jev" && span.output?.costUsd === 0.001), "Jev billing has its own model span");
      assert.deepEqual(trace?.spans.filter(span => span.kind === "model").map(span => span.name), ["integration/jev", "integration/fast", "integration/jev", "integration/fast", "integration/fast"], "each actual inference has exactly one billed span");
      assert.ok(!JSON.stringify(trace).includes("ROUTING_PRIVATE_SOURCE"), "routing trace stores no source prompt");
      const nextBefore = llmCalls.length;
      for await (const chunk of executeAgent(executionDeps, { ...executionIdentity,
        agent, configuration: routedConfiguration, messages: [{ role: "user", content: "route model task" }], actor: { kind: "user", id: "it@example.com" },
      })) assert.equal(chunk.error, undefined);
      assert.deepEqual(llmCalls.slice(nextBefore).map(call => call.model), ["model", "model", "model"], "next Run uses the new shared policy");
      assert.equal(decisionCalls.length, 2,"one physical candidate does not need a paid decision");
      pass("shared routing policy: in-flight snapshot stability and next-Run adoption");
      const disabledBefore = llmCalls.length;
      for await (const chunk of executeAgent(executionDeps, { ...executionIdentity,
        agent, configuration: { ...routedConfiguration, parameters: { ...routedConfiguration.parameters, modelRouting: false } },
        messages: [{ role: "user", content: "route model task" }], actor: { kind: "user", id: "it@example.com" },
      })) assert.equal(chunk.error, undefined);
      assert.deepEqual(llmCalls.slice(disabledBefore).map((call) => call.model), ["model", "model", "model"]);
      assert.equal(decisionCalls.length, 2, "disabled routing does not contact Jev");
      const { pendingRuntimeApproval } = await import("@/application/runtime/session");
      const sessionId = `integration-routing-approval-${suffix}`;
      const owner = "it@example.com";
      cleanup(() => executionDeps.runtimeSessions!.repository.delete(sessionId, owner));
      const approvalConfiguration = { ...routedConfiguration, parameters: { ...routedConfiguration.parameters, policy: { approvalTools: ["Skill"] } } };
      const scope = { agent, configuration: approvalConfiguration, user: executionUser, actor: { kind: "user" as const, id: owner }, conversation: { surface: "chat" as const, id: sessionId } };
      {
        for await (const chunk of executeAgent(executionDeps, { ...executionIdentity, ...scope, messages: [{ role: "user", content: "use your skill" }] })) assert.equal(chunk.error, undefined);
        const pending = await pendingRuntimeApproval(executionDeps.runtimeSessions!, sessionId, owner);
        assert.ok(pending?.approvals.length);
        await modelRegistryUseCases.saveRouting({ ...nextPolicy, maxCalls: 9 }, routingActor);
        const callsBeforeResume = llmCalls.length;
        await assert.rejects(async () => {
          for await (const chunk of executeAgent(executionDeps, { ...executionIdentity, ...scope, messages: [], resumeApproval: { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] } })) assert.equal(chunk.error, undefined);
        }, /routing policy changed/);
        assert.equal(llmCalls.length, callsBeforeResume, "changed policy cannot execute an approved call");
        assert.equal((await pendingRuntimeApproval(executionDeps.runtimeSessions!, sessionId, owner))?.revision, pending.revision, "policy refusal happens before claiming pending work");
        pass("shared routing policy: approval changes rejected before pending claim");
      }
      const restoreAt = new Date(Date.parse(routedAt) + 1).toISOString();
      await agentRepository.update({ ...current, configuration, updatedAt: restoreAt }, routedAt);
      pass("call model routing: SQL settings, Jev metadata boundary, first-response selection and continuation, billing, trace and disable");
    }

    // ---------- capped reasoning-only response: transport, billing and trace ----------
    {
      const before=llmCalls.length;
      const chunks=[];
      for await(const chunk of executeAgent(executionDeps,{ ...executionIdentity,agent,configuration:{...configuration,parameters:{...configuration.parameters,maxTokens:32}},
        messages:[{role:"user",content:"integration-empty-at-cap"}],actor:{kind:"user",id:"it@example.com"}})) chunks.push(chunk);
      assert.equal(llmCalls.length-before,1,"an exhausted reasoning response cannot launch another paid SDK turn");
      assert.ok(chunks.some(chunk=>chunk.finishReason==="output-limit"));
      assert.ok(!chunks.some(chunk=>chunk.done));
      const traceId=chunks.find(chunk=>chunk.traceId)?.traceId;
      assert.ok(traceId);
      const trace=await executionDeps.traces!.get(traceId);
      assert.equal(trace?.status,"output-limit");
      assert.equal(trace.spans.filter(span=>span.kind==="model").length,1);
      assert.equal(trace.spans.find(span=>span.kind==="model")?.output?.costUsd,0.002);
      pass("reasoning output exhaustion: no replay, actual billing and output-limit trace persistence");
    }

    // ---------- durable SDK Session + approval over PostgreSQL ----------
    {
      const { pendingRuntimeApproval } = await import("@/application/runtime/session");
      const sessionId = `integration-session-${suffix}`;
      const owner = "it@example.com";
      cleanup(() => executionDeps.runtimeSessions!.repository.delete(sessionId, owner));
      const approvalConfiguration = { ...configuration, parameters: { ...configuration.parameters, policy: { approvalTools: ["Skill"] } } };
      const base = { agent, configuration: approvalConfiguration, user: executionUser, actor: { kind: "user" as const, id: owner }, conversation: { surface: "chat" as const, id: sessionId } };
      const first = [];
      for await (const chunk of executeAgent(executionDeps, { ...executionIdentity, ...base, messages: [{ role: "user", content: "use your skill" }] })) first.push(chunk);
      assert.ok(first.some((chunk) => chunk.approval), "approval is persisted before notifying the client");
      assert.ok(!first.some((chunk) => chunk.toolResult), "a pending Skill call has not executed");
      const pending = await pendingRuntimeApproval(executionDeps.runtimeSessions!, sessionId, owner);
      assert.ok(pending && pending.approvals.length === 1);
      const callsBeforeWrongUser = llmCalls.length;
      await assert.rejects(async () => {
        for await (const _chunk of executeAgent(executionDeps, { ...executionIdentity, ...base, user: { ...base.user, userId: "another-user" },
          messages: [], resumeApproval: { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] } })) { /* drain */ }
      }, /no longer active/);
      assert.equal(llmCalls.length, callsBeforeWrongUser, "another account cannot consume a pending approval");
      assert.equal((await pendingRuntimeApproval(executionDeps.runtimeSessions!, sessionId, owner))?.status, "pending");
      const resumed = [];
      for await (const chunk of executeAgent(executionDeps, { ...executionIdentity, ...base, messages: [], resumeApproval: { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] } })) resumed.push(chunk);
      assert.ok(!resumed.some((chunk) => chunk.error), "approved SDK execution resumes successfully");
      assert.ok(resumed.some((chunk) => chunk.toolResult?.name === "Skill: integration-skill"));
      assert.equal(await pendingRuntimeApproval(executionDeps.runtimeSessions!, sessionId, owner), null);
      const before = llmCalls.length;
      for await (const chunk of executeAgent(executionDeps, { ...executionIdentity, ...base, messages: [{ role: "user", content: "continue" }] })) assert.equal(chunk.error, undefined);
      assert.equal(llmCalls.length, before + 1, "the Session replay avoids executing the previous Skill call again");
      pass("SDK Session approval persistence, restart-style resume and exact continuation");
    }

    // ---------- cascade delete ----------
    await agentRepository.delete(agentName);
    agentNeedsCleanup = false;
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
  } catch (error) {
    if (mockFailure !== undefined) throw mockFailure;
    throw error;
  }

  if (mockFailure !== undefined) throw mockFailure;
  return results.length;
}

main().catch((error) => {
  console.error("INTEGRATION FAILURE:", error);
  process.exit(1);
});
