/**
 * End-to-end integration check against DynamoDB Local and a mock LLM server.
 * Exercises every repository round-trip plus the execution engine (single-shot
 * and agent loop with the builtin Skill tool).
 *
 * Runs against the *test* DynamoDB Local instance (8084), never the dev one
 * (8083): this check writes fixtures and cascade-deletes them.
 *
 *   docker compose up -d dynamodb-test
 *   pnpm init-local-table:test
 *   pnpm test:integration
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.STAGE ??= "local";
process.env.DYNAMODB_ENDPOINT ??= "http://localhost:8084";
// The `-test` table is the second layer under the port guard below: both
// instances are shared with the other projects on this machine, so the table
// name is what separates them, and a mistake about *which* instance still
// cannot reach the table `pnpm dev` writes to.
process.env.DYNAMODB_TABLE_NAME ??= "agentdure-test";

// Refuse anything but the local test instance. This check cascade-deletes what
// it writes, and `--env-file=.env.local` (which carries the dev endpoint) is an
// easy way to aim it at 8083 by accident — where it would take the dev app's
// data with it. `init-local-table.ts` guards the same way, one port over.
const endpoint = new URL(process.env.DYNAMODB_ENDPOINT);
if (!["localhost", "127.0.0.1"].includes(endpoint.hostname) || endpoint.port !== "8084") {
  console.error(
    `Refusing to run against ${endpoint.origin}: this check writes and deletes, so it ` +
      `only runs against the local test instance (http://localhost:8084).`,
  );
  process.exit(1);
}
// Overridable so the check can run beside a `scripts/mock-llm.ts` already
// holding the default port; CI leaves it unset.
const MOCK_PORT = Number(process.env.INTEGRATION_MOCK_PORT ?? 8002);
process.env.LLM_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
process.env.LLM_API_KEY = "test";
process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

async function main() {
  const { projectRepository } = await import("@/infrastructure/db/repositories/projectRepository");
  const { versionRepository } = await import("@/infrastructure/db/repositories/versionRepository");
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
  const { mcpOAuthStateRepository } = await import(
    "@/infrastructure/db/repositories/mcpOAuthStateRepository"
  );
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const { runSlotRepository } = await import("@/infrastructure/db/repositories/runSlotRepository");
  const { triggerRepository } = await import("@/infrastructure/db/repositories/triggerRepository");
  const { auditRepository } = await import("@/infrastructure/db/repositories/auditRepository");
  const { artifactRepository } = await import(
    "@/infrastructure/db/repositories/artifactRepository"
  );
  const { telegramUpdateRepository } = await import(
    "@/infrastructure/db/repositories/telegramUpdateRepository"
  );
  const { transcriptRepository } = await import(
    "@/infrastructure/db/repositories/transcriptRepository"
  );
  const { executionDeps } = await import("@/lib/container");
  const { executeVersion, executeAgent } = await import("@/application/execution/runProject");
  const { encryptHeaders, decryptHeadersForOutbound, encryptSecret, decryptSecret } = await import(
    "@/infrastructure/crypto/secretEncryption"
  );

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
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "Skill", arguments: '{"name":"integration-skill"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
        } else {
          send({ choices: [{ delta: { content: "streamed " }, finish_reason: null }] });
          send({ choices: [{ delta: { content: "answer" }, finish_reason: null }] });
          send({ choices: [{ delta: {}, finish_reason: "stop" }] });
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
    // ---------- project + version ----------
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
    const listed = await projectRepository.list();
    assert.ok(listed.some((p) => p.name === projectName), "project list contains created");
    pass("project create/get/list");

    await versionRepository.create({
      projectName,
      versionName: "1",
      systemPrompt: "You are a helpful integration bot.",
      userPromptTemplate: "Hello {{name}}",
      model: "openai/gpt-5-mini",
      parameters: { piiFiltering: false },
      mcpList: [],
      skillList: ["integration-skill"],
      subagentList: [],
      maxTurn: 5,
      createdAt: now,
    });
    const publishedAt = new Date(Date.parse(now) + 1).toISOString();
    await projectRepository.publish(
      { ...project, publishedVersion: "1", updatedAt: publishedAt },
      "1",
      now,
    );
    const published = await versionRepository.get(projectName, "published");
    assert.ok(published, "published pointer resolves");
    assert.equal(published.versionName, "1");
    pass("version create + published pointer resolution");
    await assert.rejects(
      projectRepository.update(
        { ...project, description: "stale write", updatedAt: new Date(Date.parse(now) + 2).toISOString() },
        now,
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "ConditionalCheckFailedException",
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

    // ---------- mcp + external agent (encrypted headers) ----------
    const encrypted = encryptHeaders({ Authorization: "Bearer secret-token" });
    await mcpRepository.put({
      name: `it-mcp-${suffix}`,
      url: "http://localhost:9999/mcp",
      headers: encrypted,
      createdAt: now,
      updatedAt: now,
    });
    const mcp = await mcpRepository.get(`it-mcp-${suffix}`);
    assert.ok(mcp, "mcp get");
    assert.equal(
      decryptHeadersForOutbound(mcp.headers).Authorization,
      "Bearer secret-token",
      "mcp header encryption round-trip",
    );
    await externalAgentRepository.put({
      name: `it-agent-${suffix}`,
      url: "http://localhost:9999/v1/chat/completions",
      description: "external",
      headers: encrypted,
      createdAt: now,
      updatedAt: now,
    });
    assert.ok(await externalAgentRepository.get(`it-agent-${suffix}`), "external agent get");
    pass("mcp + external agent with encrypted headers");

    // ---------- mcp oauth connection + in-flight state ----------
    const serverName = `it-mcp-${suffix}`;
    await mcpConnectionRepository.put({
      projectName,
      serverName,
      clientId: "client-abc",
      clientSecret: encryptSecret("client-secret"),
      issuer: "https://auth.example.com",
      resource: "https://mcp.example.com",
      scopes: ["chat:write"],
      accessToken: encryptSecret("access-1"),
      refreshToken: encryptSecret("refresh-1"),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      status: "connected",
      connectedBy: "owner@example.com",
      connectedAt: now,
      updatedAt: now,
    });
    const conn = await mcpConnectionRepository.get(projectName, serverName);
    assert.ok(conn, "mcp connection get");
    assert.equal(decryptSecret(conn.clientSecret ?? ""), "client-secret", "client secret round-trip");
    // Losing either would silently unbind the credentials and tokens from the
    // servers they belong to — the whole of SEP-2352, and of the audience check
    // that stops a repointed entry carrying them somewhere else.
    assert.equal(conn.issuer, "https://auth.example.com", "credential issuer round-trip");
    assert.equal(conn.resource, "https://mcp.example.com", "token resource round-trip");
    assert.equal(
      (await mcpConnectionRepository.listByProject(projectName)).length,
      1,
      "connection listed under its project partition",
    );

    // Compare-and-set on the refresh token: the second caller refreshed from a
    // token that is no longer stored, which is the concurrent-refresh race.
    const stored = conn.refreshToken;
    assert.equal(
      await mcpConnectionRepository.updateTokens(projectName, serverName, stored, {
        accessToken: encryptSecret("access-2"),
        refreshToken: encryptSecret("refresh-2"),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        status: "connected",
        updatedAt: new Date().toISOString(),
      }),
      true,
      "refresh with the current refresh token wins",
    );
    assert.equal(
      await mcpConnectionRepository.updateTokens(projectName, serverName, stored, {
        accessToken: encryptSecret("access-3"),
        refreshToken: encryptSecret("refresh-3"),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        status: "connected",
        updatedAt: new Date().toISOString(),
      }),
      false,
      "refresh from a superseded refresh token is refused",
    );
    assert.equal(
      decryptSecret((await mcpConnectionRepository.get(projectName, serverName))?.accessToken ?? ""),
      "access-2",
      "the winner's token survives the race",
    );

    // Absent values REMOVE rather than storing null, so `attribute_not_exists`
    // stays a usable race condition afterwards. The expected value is read back
    // rather than re-encrypted: ciphertext is randomized, so only the stored one
    // can match.
    const won = await mcpConnectionRepository.get(projectName, serverName);
    assert.equal(
      await mcpConnectionRepository.updateTokens(projectName, serverName, won?.refreshToken, {
        status: "needs_reauth",
        updatedAt: new Date().toISOString(),
      }),
      true,
      "clearing tokens with the stored refresh token succeeds",
    );
    const revoked = await mcpConnectionRepository.get(projectName, serverName);
    assert.equal(revoked?.refreshToken, undefined, "cleared refresh token is absent, not null");
    assert.equal(revoked?.status, "needs_reauth", "status recorded");

    await mcpOAuthStateRepository.put(
      {
        state: `it-state-${suffix}`,
        projectName,
        serverName,
        codeVerifier: encryptSecret("verifier"),
        userEmail: "owner@example.com",
        issuer: "https://auth.example.com",
        issParameterSupported: true,
        createdAt: now,
      },
      600,
    );
    const consumed = await mcpOAuthStateRepository.consume(`it-state-${suffix}`);
    assert.equal(consumed?.userEmail, "owner@example.com", "oauth state consumed once");
    // The expected issuer has to survive the round trip or the RFC 9207 check at
    // the callback has nothing to compare against and fails the flow closed.
    assert.equal(consumed?.issuer, "https://auth.example.com", "expected issuer round-trips");
    assert.equal(consumed?.issParameterSupported, true, "iss advertisement round-trips");
    assert.equal(
      await mcpOAuthStateRepository.consume(`it-state-${suffix}`),
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
    assert.deepEqual(
      await chatRunLogRepository.read(sweptChatId, "run-1", 0),
      [],
      "deleting a chat sweeps its run log",
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
    const actorRows = await usageRepository.listActorsByProject(projectName, today, today);
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
    const dayRows = await auditRepository.listByDay(auditDay);
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
      (await a2aClientKeyRepository.list()).some((k) => k.name === clientKeyName),
      "key listed from the TYPE partition",
    );
    await a2aClientKeyRepository.delete(clientKeyName);
    assert.equal(
      await a2aClientKeyRepository.findNameByHash(clientKey.tokenHash),
      null,
      "deletion removes the hash row too",
    );
    pass("A2A client key: transactional pair, hash lookup, full deletion");

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

    // ---------- engine: single-shot ----------
    const runResult = await executeVersion(executionDeps, {
      project,
      version: published,
      variables: { name: "world" },
    });
    assert.equal(runResult.content, "plain answer", "executeVersion content");
    assert.ok(runResult.usage.inputTokens > 0, "executeVersion usage recorded");
    pass("executeVersion single-shot via mock LLM");

    // ---------- engine: agent loop with Skill tool ----------
    const chunks: Array<{ delta?: { content?: string }; toolResult?: unknown; error?: string }> =
      [];
    for await (const chunk of executeAgent(executionDeps, {
      project,
      version: published,
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

    // ---------- cascade delete ----------
    await projectRepository.delete(projectName);
    assert.equal(await projectRepository.get(projectName), null, "project deleted");
    assert.equal(await versionRepository.get(projectName, "1"), null, "versions deleted");
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
    pass("project cascade delete (meta + versions + usage + transcript)");
  } finally {
    // cleanup non-cascading fixtures
    await skillRepository.delete("integration-skill").catch(() => {});
    await mcpRepository.delete(`it-mcp-${suffix}`).catch(() => {});
    await externalAgentRepository.delete(`it-agent-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-swept-${suffix}`).catch(() => {});
    // The A2A block deletes its own key on the happy path; an assert between
    // create and delete would otherwise leak the pair into the shared table.
    await import("@/infrastructure/db/repositories/a2aClientKeyRepository")
      .then(({ a2aClientKeyRepository }) => a2aClientKeyRepository.delete(`client-${suffix}`))
      .catch(() => {});
    for (const artifactId of artifactFixtures) {
      await artifactRepository.delete(artifactId).catch(() => {});
    }
    if (auditFixtures.length > 0 || memberDayFixtures.length > 0) {
      const { getDocumentClient, getTableName } = await import("@/infrastructure/db/client");
      const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
      const { keys } = await import("@/infrastructure/db/keys");
      for (const fixture of auditFixtures) {
        await getDocumentClient()
          .send(
            new DeleteCommand({
              TableName: getTableName(),
              Key: keys.auditEvent(fixture.day, fixture.createdAt, fixture.eventId),
            }),
          )
          .catch(() => {});
      }
      for (const fixture of memberDayFixtures) {
        await getDocumentClient()
          .send(
            new DeleteCommand({
              TableName: getTableName(),
              Key: keys.usageMember(fixture.email, fixture.date, fixture.project),
            }),
          )
          .catch(() => {});
      }
    }
    mock.close();
  }

  console.log(`\n${results.length} integration checks passed`);
}

main().catch((error) => {
  console.error("INTEGRATION FAILURE:", error);
  process.exit(1);
});
