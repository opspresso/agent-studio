/**
 * End-to-end integration check against DynamoDB Local and a mock LLM server.
 * Exercises every repository round-trip plus the execution engine (single-shot
 * and agent loop with the builtin Skill tool).
 *
 * Prerequisites: DynamoDB Local reachable at DYNAMODB_ENDPOINT_URL with the
 * table created (`pnpm init-local-table`).
 *
 *   DYNAMODB_ENDPOINT_URL=http://localhost:8001 pnpm tsx scripts/integration-check.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.STAGE ??= "local";
process.env.DYNAMODB_ENDPOINT_URL ??= "http://localhost:8001";
process.env.LLM_BASE_URL = "http://127.0.0.1:8002/v1";
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
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const { executionDeps } = await import("@/lib/container");
  const { executeVersion, executeAgent } = await import("@/application/execution/runProject");
  const { encryptHeaders, decryptHeadersForOutbound } = await import("@/infrastructure/crypto/secretEncryption");

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
  await new Promise<void>((resolve) => mock.listen(8002, "127.0.0.1", resolve));

  const suffix = Date.now().toString(36);
  const projectName = `it-proj-${suffix}`;

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

    await versionRepository.put({
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
    pass("version put + published pointer resolution");

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

    // ---------- usage (atomic ADD, twice) ----------
    const usageDelta = {
      projectName,
      date: today,
      model: "openai/gpt-5-mini",
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    };
    await usageRepository.record(usageDelta);
    await usageRepository.record(usageDelta);
    const rows = await usageRepository.listByProject(projectName, today, today);
    assert.equal(rows.length, 1, "usage row exists");
    assert.equal(rows[0]?.calls["openai/gpt-5-mini"], 2, "usage calls accumulated");
    assert.equal(rows[0]?.inputTokens["openai/gpt-5-mini"], 200, "usage tokens accumulated");
    const rangeRows = await usageRepository.listByDateRange(today, today);
    assert.ok(
      rangeRows.some((r) => r.projectName === projectName),
      "usage date-range GSI listing",
    );
    pass("usage atomic ADD accumulation + range query");

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
      userEmail: "it@example.com",
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
    pass("project cascade delete (meta + versions + usage)");
  } finally {
    // cleanup non-cascading fixtures
    await skillRepository.delete("integration-skill").catch(() => {});
    await mcpRepository.delete(`it-mcp-${suffix}`).catch(() => {});
    await externalAgentRepository.delete(`it-agent-${suffix}`).catch(() => {});
    await chatRepository.delete(`it-chat-${suffix}`).catch(() => {});
    mock.close();
  }

  console.log(`\n${results.length} integration checks passed`);
}

main().catch((error) => {
  console.error("INTEGRATION FAILURE:", error);
  process.exit(1);
});
