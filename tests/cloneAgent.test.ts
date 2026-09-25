process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { describe, expect, it } from "vitest";
import { composeCloneAgent } from "@/application/agent/cloneAgentFlow";
import type { ConfigurationRefRepos } from "@/application/agent/configurationPolicy";
import { ConflictError, ForbiddenError } from "@/application/errors";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";

const OWNER = "owner@x.com";
const CLONER = "cloner@x.com";

// Every reference in the copied Agent configuration resolves; existence is not under test.
const RESOLVING_REFS = {
  skills: { get: async () => ({}) },
  mcps: { get: async () => ({}) },
  agents: { get: async () => ({}) },
} as unknown as ConfigurationRefRepos;

function sourceAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "source",
    displayName: "Source",
    description: "the original",
    ownerEmail: OWNER,
    departmentCode: "eng",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sourceConfiguration(overrides: Partial<AgentConfiguration> = {}): AgentConfiguration {
  return {
    agentName: "source",

    systemPrompt: "be helpful",

    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: true },
    mcpList: [
      {
        name: "docs",
        headers: { "X-Api-Key": "enc:v1:secret" },
        headerTarget: "sha256-target",
        tools: ["search"],
      },
    ],
    skillList: ["summarize"],
    subagentList: [{ name: "helper" }],
    maxTurn: 5,

    ...overrides,
  };
}

function makeRepos(agents: Agent[], configurations: AgentConfiguration[]) {
  const agentsByName = new Map<string, Agent>(agents.map(agent => [agent.name, { ...agent,
    configuration: configurations.find(configuration => configuration.agentName === agent.name) }]));
  const agentRepo = {
    get: async (name: string) => agentsByName.get(name) ?? null,
    create: async (agent: Agent) => { agentsByName.set(agent.name, agent); },
    update: async (agent: Agent) => { agentsByName.set(agent.name, agent); },
  } as unknown as AgentRepository;
  return { agentRepo, agentsByName };
}

function makeClone(repos: ReturnType<typeof makeRepos>) {
  return composeCloneAgent({
    agents: repos.agentRepo,
    refs: RESOLVING_REFS,
    cipher: secretCipher,
  });
}

const INPUT = { sourceName: "source", name: "copy", displayName: "Copy", userEmail: CLONER };

describe("cloneAgent", () => {
  it("copies current settings into an Agent owned by the cloner", async () => {
    const repos = makeRepos(
      [sourceAgent({  })],
      [sourceConfiguration()],
    );
    const { agent, warning } = await makeClone(repos)(INPUT);

    expect(warning).toBeUndefined();
    expect(agent).toMatchObject({
      name: "copy",
      displayName: "Copy",
      description: "the original",
      ownerEmail: CLONER,
      departmentCode: "eng",
    });
    const copied = [repos.agentsByName.get("copy")!.configuration];
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({

      systemPrompt: "be helpful",
      model: "openai/gpt-5-mini",
      skillList: ["summarize"],
      subagentList: [{ name: "helper" }],
      maxTurn: 5,
    });
  });

  it("drops MCP header overrides but keeps the binding and its tool selection", async () => {
    const repos = makeRepos([sourceAgent({  })], [sourceConfiguration()]);
    await makeClone(repos)(INPUT);

    const [binding] = repos.agentsByName.get("copy")!.configuration!.mcpList;
    expect(binding).toEqual({ name: "docs", tools: ["search"] });
  });

  it("creates an unconfigured clone of an unconfigured source, with nothing to warn about", async () => {
    const repos = makeRepos([sourceAgent()], []);
    const { agent, warning } = await makeClone(repos)(INPUT);

    expect(agent.name).toBe("copy");
    expect(warning).toBeUndefined();
    expect(agent.configuration).toBeUndefined();
  });

  it("reports a configuration that cannot be copied", async () => {
    const repos = makeRepos([sourceAgent()], [sourceConfiguration()]);
    const clone = composeCloneAgent({
      agents: repos.agentRepo,
      // Every reference in the source Agent configuration fails to resolve.
      refs: {
        skills: { get: async () => null },
        mcps: { get: async () => null },
        agents: { get: async () => null },
      } as unknown as ConfigurationRefRepos,
      cipher: secretCipher,
    });

    const { agent, warning } = await clone(INPUT);

    expect(agent.name).toBe("copy");
    expect(warning).toContain("could not be copied");
    expect(agent.configuration).toBeUndefined();
  });

  it("clones a private source as a private agent with an empty invite list", async () => {
    const repos = makeRepos(
      [sourceAgent({ visibility: "private", memberEmails: [CLONER, "other@x.com"] })],
      [sourceConfiguration()],
    );
    const { agent } = await makeClone(repos)(INPUT);

    expect(agent.visibility).toBe("private");
    expect(agent.memberEmails).toBeUndefined();
  });

  it("refuses a private source the caller cannot access", async () => {
    const repos = makeRepos([sourceAgent({ visibility: "private" })], [sourceConfiguration()]);
    await expect(makeClone(repos)(INPUT)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repos.agentsByName.has("copy")).toBe(false);
  });

  it("clones a private source for an invited member", async () => {
    const repos = makeRepos(
      [sourceAgent({ visibility: "private", memberEmails: [CLONER] })],
      [sourceConfiguration()],
    );
    await expect(makeClone(repos)(INPUT)).resolves.toMatchObject({ agent: { name: "copy" } });
  });

  it("refuses a target name that already exists", async () => {
    const repos = makeRepos(
      [sourceAgent(), sourceAgent({ name: "copy" })],
      [sourceConfiguration()],
    );
    await expect(makeClone(repos)(INPUT)).rejects.toBeInstanceOf(ConflictError);
  });
});
