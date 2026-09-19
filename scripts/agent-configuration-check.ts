import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertLocalDatabase } from "./local-database";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { skillRepository } from "@/infrastructure/db/repositories/skillRepository";
import { externalAgentRepository } from "@/infrastructure/db/repositories/externalAgentRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { keys } from "@/infrastructure/db/keys";
import { deleteItem, putItem, queryItems } from "@/infrastructure/db/store";
import { agentMcpHeadersContext } from "@/domain/security/secretContext";
import { createConfigurationUseCases } from "@/application/project/configurationUseCases";

/** Verify current settings, credential context and CAS against the real item store. */
export async function checkAgentConfiguration(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  const name = `configuration-${randomUUID()}`;
  const server = `${name}-mcp`;
  const owner = "configuration@example.test";
  const now = new Date().toISOString();
  const useCases = createConfigurationUseCases({ projects: projectRepository, cipher: secretCipher,
    refs: { projects: projectRepository, mcps: mcpRepository, skills: skillRepository, externalAgents: externalAgentRepository } });
  await projectRepository.create({ name, displayName: name, description: "", projectType: "agent",
    ownerEmail: owner, createdAt: now, updatedAt: now });
  try {
    await putItem({ ...keys.mcp(server), name: server, url: "https://configuration.example.test/mcp",
      headers: {}, description: "Fixture", createdAt: now, updatedAt: now });
    const input = { systemPrompt: "Initial", model: "openai/gpt-5-mini", parameters: { piiFiltering: true },
      mcpList: [{ name: server, headers: { Authorization: "Bearer integration-configuration-fixture" } }],
      skillList: [], subagentList: [], expectedUpdatedAt: now };
    const saved = await useCases.put(name, input, owner);
    const snapshot = (await projectRepository.get(name))!.configuration!;
    const headers = snapshot.mcpList[0]!.headers! as Record<string, string>;
    assert.ok(headers.Authorization!.startsWith("enc:v2:"));
    assert.equal(secretCipher.decryptHeadersForOutbound(headers, agentMcpHeadersContext(name, server)).Authorization,
      input.mcpList[0]!.headers.Authorization);
    assert.notEqual(saved.configuration!.mcpList[0]!.headers!.Authorization, headers.Authorization);
    const results = await Promise.allSettled(["A", "B"].map(systemPrompt => useCases.put(name,
      { ...input, mcpList: saved.configuration!.mcpList, systemPrompt, expectedUpdatedAt: saved.updatedAt }, owner)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(snapshot.systemPrompt, "Initial", "a previously admitted snapshot does not change");
    await assert.rejects(useCases.put(name, input, owner), /modified by another request/);
    assert.equal((await queryItems({ pk: keys.projectPartition(name), sk: { prefix: keys.versionPrefix() }, limit: 1 })).length, 0);
    await projectRepository.delete(name);
    await assert.rejects(useCases.put(name, input, owner), /not found/);
    console.log("[ok] Agent current settings: encrypted MCP credentials, project CAS and deletion fencing");
  } finally {
    if (await projectRepository.get(name, { includeDeleting: true })) await projectRepository.delete(name);
    await deleteItem(keys.mcp(server));
  }
}
