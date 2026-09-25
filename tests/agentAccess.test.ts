process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { beforeEach, describe, expect, it } from "vitest";

import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import {
  isAgentPrivate,
  mayAccessAgent,
  normalizeMemberEmails,
} from "@/domain/agent/access";
import {
  assertAgentAccessible,
  listAgents,
  listAccessibleAgents,
  setAdminCheck,
  updateAgent,
} from "@/application/agent/agentUseCases";
import { putAgentConfiguration } from "@/application/agent/configurationUseCases";
import type { ConfigurationRefRepos } from "@/application/agent/configurationPolicy";
import { sanitizeAgent } from "@/app/api/agents/_lib/http";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";

const OWNER = "owner@x.com";
const MEMBER = "member@x.com";
const STRANGER = "stranger@x.com";
const ADMIN = "admin@x.com";

// Wired exactly as the composition root does; default empty, like a deployment
// that never set ADMIN_EMAILS.
const admins = { emails: [] as string[] };
setAdminCheck(async (email: string) => admins.emails.includes(email.toLowerCase()));
beforeEach(() => {
  admins.emails = [];
});

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "proj",
    displayName: "Proj",
    description: "",
    ownerEmail: OWNER,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** In-memory repository over the methods these use cases reach. */
function fakeRepo(agents: Agent[]): AgentRepository {
  const byName = new Map(agents.map((p) => [p.name, p]));
  return {
    get: async (name) => byName.get(name) ?? null,
    list: async (limit, after) =>
      [...byName.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((p) => !after || p.name > after)
        .slice(0, limit),
    create: async (p) => void byName.set(p.name, p),
    update: async (p) => void byName.set(p.name, p),
    delete: async (name) => void byName.delete(name),
    getApiToken: async () => null,
    setApiToken: async () => {},
    deleteApiToken: async () => {},
  };
}

describe("mayAccessAgent", () => {
  it("treats an absent visibility as public", () => {
    expect(isAgentPrivate(agent())).toBe(false);
    expect(mayAccessAgent(agent(), STRANGER)).toBe(true);
  });

  it("lets anyone into an explicitly public agent", () => {
    expect(mayAccessAgent(agent({ visibility: "public" }), STRANGER)).toBe(true);
  });

  it("keeps a stranger out of a private agent", () => {
    expect(mayAccessAgent(agent({ visibility: "private" }), STRANGER)).toBe(false);
  });

  it("always admits the owner, case-insensitively", () => {
    const p = agent({ visibility: "private", ownerEmail: "Owner@X.com" });
    expect(mayAccessAgent(p, "owner@x.com")).toBe(true);
  });

  it("admits an invited member, case-insensitively", () => {
    const p = agent({ visibility: "private", memberEmails: [MEMBER] });
    expect(mayAccessAgent(p, "Member@X.com")).toBe(true);
    expect(mayAccessAgent(p, STRANGER)).toBe(false);
  });

  it("ignores the invite list while the agent is public", () => {
    const p = agent({ memberEmails: [MEMBER] });
    expect(mayAccessAgent(p, STRANGER)).toBe(true);
  });
});

describe("normalizeMemberEmails", () => {
  it("trims, lowercases, dedupes, and drops the owner and empties", () => {
    expect(
      normalizeMemberEmails(
        ["  A@x.com ", "a@x.com", "b@x.com", OWNER.toUpperCase(), "   "],
        OWNER,
      ),
    ).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("assertAgentAccessible", () => {
  const repos = () =>
    fakeRepo([
      agent(),
      agent({ name: "secret", visibility: "private", memberEmails: [MEMBER] }),
    ]);

  it("404s an unknown agent", async () => {
    await expect(assertAgentAccessible(repos(), "nope", STRANGER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("admits anyone to a public agent", async () => {
    await expect(assertAgentAccessible(repos(), "proj", STRANGER)).resolves.toMatchObject({
      name: "proj",
    });
  });

  it("403s a stranger on a private agent", async () => {
    await expect(assertAgentAccessible(repos(), "secret", STRANGER)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("admits the owner and an invited member to a private agent", async () => {
    await expect(assertAgentAccessible(repos(), "secret", OWNER)).resolves.toBeDefined();
    await expect(assertAgentAccessible(repos(), "secret", MEMBER)).resolves.toBeDefined();
  });

  it("admits a configured admin to a private agent", async () => {
    admins.emails = [ADMIN];
    await expect(assertAgentAccessible(repos(), "secret", ADMIN)).resolves.toBeDefined();
  });
});

describe("listAccessibleAgents", () => {
  const repos = () =>
    fakeRepo([
      agent(),
      agent({ name: "mine", visibility: "private", ownerEmail: STRANGER }),
      agent({ name: "invited", visibility: "private", memberEmails: [STRANGER] }),
      agent({ name: "hidden", visibility: "private" }),
    ]);

  it("returns public agents plus the private ones owned or invited", async () => {
    const names = (await listAccessibleAgents(repos(), STRANGER)).map((p) => p.name).sort();
    expect(names).toEqual(["invited", "mine", "proj"]);
  });

  it("returns everything to a configured admin", async () => {
    admins.emails = [ADMIN];
    const names = (await listAccessibleAgents(repos(), ADMIN)).map((p) => p.name).sort();
    expect(names).toEqual(["hidden", "invited", "mine", "proj"]);
  });
});

describe("listAgents", () => {
  it("reads every agent through bounded repository pages", async () => {
    const agents = Array.from({ length: 102 }, (_, index) =>
      agent({ name: `agent-${String(index).padStart(3, "0")}` }),
    );
    const repo = fakeRepo(agents);
    const list = repo.list.bind(repo);
    const pageSizes: number[] = [];
    repo.list = async (limit, after) => {
      const page = await list(limit, after);
      pageSizes.push(page.length);
      return page;
    };

    await expect(listAgents(repo)).resolves.toHaveLength(agents.length);
    expect(pageSizes).toEqual([100, 2]);
  });
});

describe("updateAgent visibility", () => {
  it("stores visibility and the normalized invite list", async () => {
    const repo = fakeRepo([agent()]);
    const updated = await updateAgent(
      repo,
      "proj",
      { visibility: "private", memberEmails: [" Member@X.com ", OWNER] },
      OWNER,
    );
    expect(updated.visibility).toBe("private");
    expect(updated.memberEmails).toEqual([MEMBER]);
  });

  it("keeps both fields when the update does not mention them", async () => {
    const repo = fakeRepo([
      agent({ visibility: "private", memberEmails: [MEMBER] }),
    ]);
    const updated = await updateAgent(repo, "proj", { description: "new" }, OWNER);
    expect(updated.visibility).toBe("private");
    expect(updated.memberEmails).toEqual([MEMBER]);
  });
});

describe("sanitizeAgent and the invite list", () => {
  it("exposes only capability flags needed by Agent navigation", () => {
    const configuration: AgentConfiguration = {
      agentName: "proj", systemPrompt: "", model: "openai/gpt-5-mini",
      parameters: { piiFiltering: false, audioProcessing: true, workspaceTools: true },
      mcpList: [], skillList: [], subagentList: [],
    };
    const enabled = sanitizeAgent(agent({ configuration }));
    expect(enabled).toMatchObject({ configured: true, audioToolsEnabled: true, workspaceToolsEnabled: true });
    expect(enabled).not.toHaveProperty("configuration");
    expect(sanitizeAgent(agent())).toMatchObject({ configured: false, audioToolsEnabled: false, workspaceToolsEnabled: false });
  });

  it("strips memberEmails unless the viewer manages the agent", () => {
    const p = agent({ visibility: "private", memberEmails: [MEMBER] });
    expect(sanitizeAgent(p)).not.toHaveProperty("memberEmails");
    expect(sanitizeAgent(p, { withMemberEmails: true }).memberEmails).toEqual([MEMBER]);
    // Visibility itself stays: the list badge and settings form read it.
    expect(sanitizeAgent(p).visibility).toBe("private");
  });
});

describe("binding a private agent as a local subagent", () => {
  const EDITOR = MEMBER;

  function accessRefs(subagent: Agent): ConfigurationRefRepos {
    return {
      skills: { get: async () => null },
      mcps: { get: async () => null },
      agents: { get: async () => subagent },
    } as unknown as ConfigurationRefRepos;
  }

  const input = {
    systemPrompt: "",

    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [{ name: "secret" }],
  };

  async function cipher() {
    return (await import("@/infrastructure/crypto/secretCipher")).secretCipher;
  }

  it("refuses an editor the subagent keeps out", async () => {
    const repo = fakeRepo([agent({ name: "mine", ownerEmail: EDITOR })]);
    const secret = agent({ name: "secret", visibility: "private" });
    await expect(
      putAgentConfiguration({ agents: repo, refs: accessRefs(secret), cipher: await cipher() }, "mine", { ...input, expectedUpdatedAt: (await repo.get("mine"))!.updatedAt }, EDITOR),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("lets an invited editor bind it", async () => {
    const repo = fakeRepo([agent({ name: "mine", ownerEmail: EDITOR })]);
    const secret = agent({ name: "secret", visibility: "private", memberEmails: [EDITOR] });
    await putAgentConfiguration({ agents: repo, refs: accessRefs(secret), cipher: await cipher() }, "mine", { ...input, expectedUpdatedAt: (await repo.get("mine"))!.updatedAt }, EDITOR);
    expect((await repo.get("mine"))?.configuration?.subagentList).toEqual([{ name: "secret" }]);
  });

  it("keeps current settings editable after a bound agent went private", async () => {
    const repo = fakeRepo([agent({ name: "mine", ownerEmail: EDITOR })]);
    const secret = agent({ name: "secret", visibility: "private" });
    const existing = (await repo.get("mine"))!;
    const configuration: AgentConfiguration = { ...input, agentName: "mine" };
    await repo.update({ ...existing, configuration }, existing.updatedAt);
    const updated = await putAgentConfiguration(
      { agents: repo, refs: accessRefs(secret), cipher: await cipher() },
      "mine", { ...input, systemPrompt: "new", expectedUpdatedAt: existing.updatedAt }, EDITOR,
    );
    expect(updated.configuration?.systemPrompt).toBe("new");
  });
});
