import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseMcpDoc,
  parsePluginSkillDoc,
  syncPluginsFromSnapshot,
  type SyncPluginsDeps,
} from "@/application/plugin/syncPlugins";
import type { CreateMcpInput, McpUseCases, UpdateMcpInput } from "@/application/mcp/mcpUseCases";
import type { SkillRepository } from "@/domain/skill/repository";
import type { Skill } from "@/domain/skill/types";
import type { McpServer } from "@/domain/mcp/types";
import type { Plugin } from "@/domain/plugin/types";
import { MCP_JSON_SCHEMA, PLUGIN_MANIFEST_SCHEMA } from "@/domain/plugin/types";
import type {
  PluginsRepoSnapshot,
  PluginSyncResult,
  RepoPlugin,
  RepoPluginSkill,
} from "@/domain/plugin/sync";
import { ConflictError, ValidationError } from "@/application/errors";

const REPO = "opspresso/agent-plugins";
const NOW = "2026-02-02T00:00:00.000Z";
const BEFORE = "2025-01-01T00:00:00.000Z";
/** Every sync is asked for by somebody; the actor is what its deletions record. */
const ACTOR = "admin@example.com";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

// --- fakes -------------------------------------------------------------------

function fakeSkills(existing: Skill[] = []) {
  const store = new Map(existing.map((skill) => [skill.name, skill]));
  const puts: Skill[] = [];
  const removed: Array<{ name: string; actor: string }> = [];
  const repo: SkillRepository = {
    async get(name) {
      return store.get(name) ?? null;
    },
    async describe(names) {
      return names.flatMap((name) => {
        const skill = store.get(name);
        return skill ? [{ name, description: skill.description }] : [];
      });
    },
    async list() {
      return [...store.values()];
    },
    async create(skill) {
      store.set(skill.name, skill);
    },
    async update(skill) {
      store.set(skill.name, skill);
    },
    async put(skill) {
      puts.push(skill);
      store.set(skill.name, skill);
    },
    async delete(name) {
      store.delete(name);
    },
  };
  const useCases = {
    async remove(name: string, actorEmail: string) {
      removed.push({ name, actor: actorEmail });
      store.delete(name);
    },
  };
  return { repo, useCases, puts, removed, store };
}

function fakeMcps(existing: McpServer[] = [], refuse: Record<string, Error> = {}) {
  const store = new Map(existing.map((server) => [server.name, server]));
  const created: CreateMcpInput[] = [];
  const patched: Array<{ name: string; patch: UpdateMcpInput }> = [];
  const removed: Array<{ name: string; actor: string }> = [];
  const mcps: Pick<McpUseCases, "list" | "create" | "update" | "remove"> = {
    async list() {
      return [...store.values()];
    },
    async create(input) {
      const failure = refuse[input.name];
      if (failure) {
        throw failure;
      }
      created.push(input);
      const server: McpServer = {
        name: input.name,
        url: input.url,
        description: input.description,
        content: input.content,
        source: input.source,
        headers: {},
        createdAt: NOW,
        updatedAt: NOW,
      };
      store.set(server.name, server);
      return server;
    },
    async update(name, patch) {
      const failure = refuse[name];
      if (failure) {
        throw failure;
      }
      patched.push({ name, patch });
      const current = store.get(name)!;
      const next: McpServer = {
        ...current,
        url: patch.url ?? current.url,
        description: patch.description ?? current.description,
        content: patch.content ?? current.content,
        source: patch.source ?? current.source,
        updatedAt: NOW,
      };
      store.set(name, next);
      return next;
    },
    async remove(name, actorEmail) {
      removed.push({ name, actor: actorEmail });
      store.delete(name);
    },
  };
  return { mcps, created, patched, removed, store };
}

function fakePlugins(existing: Plugin[] = []) {
  const store = new Map(existing.map((plugin) => [plugin.name, plugin]));
  const puts: Plugin[] = [];
  const removed: Array<{ name: string; actor: string }> = [];
  return {
    plugins: {
      async get(name: string) {
        return store.get(name) ?? null;
      },
      async list() {
        return [...store.values()];
      },
      async put(plugin: Plugin) {
        puts.push(plugin);
        store.set(plugin.name, plugin);
      },
      async delete(name: string) {
        store.delete(name);
      },
    },
    pluginRows: {
      async remove(name: string, actorEmail: string) {
        removed.push({ name, actor: actorEmail });
        store.delete(name);
      },
    },
    puts,
    removed,
    store,
  };
}

function makeDeps(opts: {
  skills?: Skill[];
  servers?: McpServer[];
  pluginRows?: Plugin[];
  refuse?: Record<string, Error>;
} = {}) {
  const skills = fakeSkills(opts.skills);
  const mcps = fakeMcps(opts.servers, opts.refuse);
  const plugins = fakePlugins(opts.pluginRows);
  const deps: SyncPluginsDeps = {
    plugins: plugins.plugins,
    pluginRows: plugins.pluginRows,
    skillRepo: skills.repo,
    skills: skills.useCases,
    mcps: mcps.mcps,
  };
  return { deps, skills, mcps, plugins };
}

// --- snapshot builders -------------------------------------------------------

function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA, name, ...extra });
}

function mcpJson(servers: Record<string, unknown>): string {
  return JSON.stringify({ $schema: MCP_JSON_SCHEMA, mcpServers: servers });
}

function httpServer(url = "https://mcp.example.test/mcp"): Record<string, unknown> {
  return { type: "streamable-http", url };
}

function skillDoc(name: string, description = "Does the thing.", body = "# Guide\n\nSteps."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function repoSkill(plugin: string, name: string, content?: string): RepoPluginSkill {
  return {
    name,
    path: `plugins/${plugin}/skills/${name}/SKILL.md`,
    content: content ?? skillDoc(name),
    files: [],
  };
}

function repoPlugin(name: string, partial: Partial<RepoPlugin> = {}): RepoPlugin {
  return {
    rootPath: `plugins/${name}`,
    manifestRaw: manifest(name),
    skills: [],
    mcpDocs: [],
    skippedAttachments: [],
    badSkillDirs: [],
    ...partial,
  };
}

function snapshot(plugins: RepoPlugin[], nestedRoots: string[] = []): PluginsRepoSnapshot {
  return { repo: REPO, branch: "main", commitSha: "abc123", plugins, nestedRoots };
}

function storedSkill(name: string, over: Partial<Skill> = {}): Skill {
  return {
    name,
    description: "Does the thing.",
    content: "# Guide\n\nSteps.",
    source: `github:${REPO}#devops`,
    createdAt: BEFORE,
    updatedAt: BEFORE,
    ...over,
  };
}

function storedServer(name: string, over: Partial<McpServer> = {}): McpServer {
  return {
    name,
    url: "https://mcp.example.test/mcp",
    source: `github:${REPO}#devops`,
    headers: {},
    createdAt: BEFORE,
    updatedAt: BEFORE,
    ...over,
  };
}

function section(result: PluginSyncResult, plugin: string) {
  const found = result.plugins.find((candidate) => candidate.plugin === plugin);
  if (!found) {
    throw new Error(`no section for plugin ${plugin}`);
  }
  return found;
}

// --- document parsing --------------------------------------------------------

describe("parsePluginSkillDoc", () => {
  it("reads a conformant document", () => {
    expect(parsePluginSkillDoc("gitops", skillDoc("gitops", "Desc.", "Body."))).toEqual({
      ok: true,
      doc: { description: "Desc.", body: "Body." },
    });
  });

  it.each([
    ["a name that does not match the directory", skillDoc("other")],
    ["a missing name", "---\ndescription: x\n---\nbody"],
    ["a missing description", "---\nname: gitops\n---\nbody"],
    ["a description over the spec's cap", skillDoc("gitops", "x".repeat(1025))],
  ])("refuses %s", (_case, raw) => {
    expect(parsePluginSkillDoc("gitops", raw).ok).toBe(false);
  });
});

describe("parseMcpDoc", () => {
  it("reads the description and keeps the body as operator notes", () => {
    expect(parseMcpDoc("---\ndescription: Argo CD ops\n---\n\n# argocd\n\nNotes.")).toEqual({
      description: "Argo CD ops",
      content: "# argocd\n\nNotes.",
    });
  });

  it("invents nothing when the document declares nothing", () => {
    expect(parseMcpDoc("")).toEqual({});
  });
});

// --- the sync ----------------------------------------------------------------

describe("syncPluginsFromSnapshot", () => {
  it("creates skills and servers with plugin-scoped provenance", async () => {
    const { deps, skills, mcps } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          skills: [repoSkill("devops", "gitops")],
          mcpJsonRaw: mcpJson({ argocd: httpServer() }),
          mcpDocs: [
            {
              server: "argocd",
              path: "plugins/devops/org.opspresso.agent-studio/mcp/argocd.md",
              content: "---\ndescription: Argo CD ops\n---\nNotes.",
            },
          ],
        }),
      ]),
      ACTOR,
    );

    expect(section(result, "devops").skills.created).toEqual(["gitops"]);
    expect(section(result, "devops").mcpServers.created).toEqual(["argocd"]);
    expect(skills.puts[0]).toMatchObject({
      name: "gitops",
      source: `github:${REPO}#devops`,
      createdAt: NOW,
    });
    expect(mcps.created[0]).toMatchObject({
      name: "argocd",
      url: "https://mcp.example.test/mcp",
      description: "Argo CD ops",
      content: "Notes.",
      source: `github:${REPO}#devops`,
      headers: {},
    });
  });

  it("reports a non-conformant SKILL.md and writes nothing for it", async () => {
    const { deps, skills } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          skills: [
            repoSkill("devops", "renamed", skillDoc("other-name")),
            repoSkill("devops", "silent", "---\nname: silent\n---\nno description"),
          ],
        }),
      ]),
      ACTOR,
    );

    expect(section(result, "devops").skills.skipped.map((skip) => skip.reason)).toEqual([
      "invalid-skill",
      "invalid-skill",
    ]);
    expect(skills.puts).toEqual([]);
  });

  it("applies a changed document automatically, preserving createdAt", async () => {
    const { deps, skills } = makeDeps({
      skills: [storedSkill("gitops", { content: "older body" })],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { skills: [repoSkill("devops", "gitops")] })]),
      ACTOR,
    );

    expect(section(result, "devops").skills.overwritten).toEqual(["gitops"]);
    expect(skills.puts[0]).toMatchObject({ createdAt: BEFORE, updatedAt: NOW });
  });

  it("does not write an entry that already agrees", async () => {
    const { deps, skills } = makeDeps({ skills: [storedSkill("gitops")] });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { skills: [repoSkill("devops", "gitops")] })]),
      ACTOR,
    );

    expect(section(result, "devops").skills.unchanged).toEqual(["gitops"]);
    expect(skills.puts).toEqual([]);
  });

  it("takes over a legacy-source entry automatically, provenance included", async () => {
    const legacy = storedSkill("gitops", { source: "github:opspresso/agent-skills" });
    const { deps, skills } = makeDeps({ skills: [legacy] });

    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { skills: [repoSkill("devops", "gitops")] })]),
      ACTOR,
    );

    expect(section(result, "devops").skills.overwritten).toEqual(["gitops"]);
    expect(skills.puts[0]).toMatchObject({
      source: `github:${REPO}#devops`,
      createdAt: BEFORE,
    });
  });

  it("takes over a server the same way, through the update patch", async () => {
    const { deps, mcps } = makeDeps({
      servers: [storedServer("argocd", { source: "github:opspresso/agent-tools" })],
    });

    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { mcpJsonRaw: mcpJson({ argocd: httpServer() }) })]),
      ACTOR,
    );

    expect(section(result, "devops").mcpServers.overwritten).toEqual(["argocd"]);
    expect(mcps.patched).toEqual([
      { name: "argocd", patch: { source: `github:${REPO}#devops` } },
    ]);
  });

  it("never touches a hand-registered entry — it was never any repository's", async () => {
    const { deps, skills, mcps } = makeDeps({
      skills: [storedSkill("gitops", { source: undefined })],
      servers: [storedServer("argocd", { source: undefined })],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          skills: [repoSkill("devops", "gitops")],
          mcpJsonRaw: mcpJson({ argocd: httpServer() }),
        }),
      ]),
      ACTOR,
    );

    const devops = section(result, "devops");
    expect(devops.skills.overwritten).toEqual([]);
    expect(devops.skills.skipped).toEqual([
      { name: "gitops", reason: "conflict", detail: "registered by hand; not offered for overwrite" },
    ]);
    expect(devops.mcpServers.skipped).toEqual([
      { name: "argocd", reason: "conflict", detail: "registered by hand; not offered for overwrite" },
    ]);
    expect(skills.puts).toEqual([]);
    expect(mcps.patched).toEqual([]);
  });

  it("skips every claimant of a name two plugins declare", async () => {
    const { deps, skills } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", { skills: [repoSkill("devops", "shared")] }),
        repoPlugin("research", { skills: [repoSkill("research", "shared")] }),
      ]),
      ACTOR,
    );

    expect(section(result, "devops").skills.skipped).toEqual([
      { name: "shared", reason: "duplicate-name", detail: "also declared by research" },
    ]);
    expect(section(result, "research").skills.skipped).toEqual([
      { name: "shared", reason: "duplicate-name", detail: "also declared by devops" },
    ]);
    expect(skills.puts).toEqual([]);
  });

  it("skips a stdio or sse server without ever creating it", async () => {
    const { deps, mcps } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          mcpJsonRaw: mcpJson({
            local: { type: "stdio", command: "./bin/server" },
            old: { type: "sse", url: "https://x.test/sse" },
          }),
        }),
      ]),
      ACTOR,
    );

    expect(section(result, "devops").mcpServers.skipped).toEqual([
      { name: "local", reason: "unsupported-transport", detail: "stdio" },
      { name: "old", reason: "unsupported-transport", detail: "sse" },
    ]);
    expect(mcps.created).toEqual([]);
  });

  it("creates a server whose mcp.json declared headers, and says what was dropped", async () => {
    const { deps, mcps } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          mcpJsonRaw: mcpJson({
            argocd: {
              type: "streamable-http",
              url: "https://mcp.example.test/mcp",
              headers: { Authorization: "leaked", "X-Tenant": "default" },
            },
          }),
        }),
      ]),
      ACTOR,
    );

    const report = section(result, "devops").mcpServers;
    expect(report.created).toEqual(["argocd"]);
    expect(report.skipped).toEqual([
      // Names only — a value from git must not even reach the report.
      { name: "argocd", reason: "headers-dropped", detail: "Authorization, X-Tenant" },
    ]);
    expect(mcps.created[0]?.headers).toEqual({});
  });

  it("reports a bad server name and an invalid entry without failing the file", async () => {
    const { deps, mcps } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          mcpJsonRaw: mcpJson({
            "Bad Name": httpServer(),
            broken: { type: "streamable-http" },
            fine: httpServer("https://fine.test/mcp"),
          }),
        }),
      ]),
      ACTOR,
    );

    const report = section(result, "devops").mcpServers;
    expect(report.skipped).toEqual([
      { name: "Bad Name", reason: "bad-name" },
      {
        name: "broken",
        reason: "invalid-manifest",
        detail: "a streamable-http server must declare a url",
      },
    ]);
    expect(mcps.created.map((input) => input.name)).toEqual(["fine"]);
  });

  it("reports an unusable mcp.json in the plugin's section and an unusable plugin.json at repo level", async () => {
    const { deps } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot(
        [
          repoPlugin("devops", { mcpJsonRaw: "{nope" }),
          repoPlugin("broken", { manifestRaw: "{nope" }),
        ],
        ["plugins/devops/skills/inner/plugin.json"],
      ),
      ACTOR,
    );

    expect(section(result, "devops").mcpServers.skipped[0]).toMatchObject({
      name: "mcp.json",
      reason: "invalid-manifest",
    });
    expect(result.skipped).toEqual([
      {
        name: "plugins/devops/skills/inner/plugin.json",
        reason: "invalid-manifest",
        detail: "plugin root nested inside another plugin",
      },
      expect.objectContaining({ name: "plugins/broken/plugin.json", reason: "invalid-manifest" }),
    ]);
    expect(result.plugins.map((entry) => entry.plugin)).toEqual(["devops"]);
  });

  it("refuses every plugin claiming a duplicated plugin name", async () => {
    const { deps, plugins } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", { rootPath: "plugins/a", skills: [repoSkill("a", "one")] }),
        repoPlugin("devops", { rootPath: "plugins/b", skills: [repoSkill("b", "two")] }),
      ]),
      ACTOR,
    );

    expect(result.skipped).toEqual([
      { name: "devops", reason: "duplicate-name", detail: "declared at plugins/a, plugins/b" },
    ]);
    expect(result.plugins).toEqual([]);
    expect(plugins.puts).toEqual([]);
  });

  it("leaves a stored description alone when the plugin carries no extension document", async () => {
    const { deps, mcps } = makeDeps({
      servers: [storedServer("argocd", { description: "typed by an operator" })],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { mcpJsonRaw: mcpJson({ argocd: httpServer() }) })]),
      ACTOR,
    );

    // Nothing differs: the document does not carry a description, so it says
    // nothing about the stored one.
    expect(section(result, "devops").mcpServers.unchanged).toEqual(["argocd"]);
    expect(mcps.patched).toEqual([]);
  });

  it("keeps a managed server's address out of the patch and says so", async () => {
    const { deps, mcps } = makeDeps({
      servers: [
        storedServer("memory", {
          runtime: "managed",
          url: "http://127.0.0.1:9101/mcp",
        }),
      ],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          mcpJsonRaw: mcpJson({ memory: httpServer("https://elsewhere.test/mcp") }),
        }),
      ]),
      ACTOR,
    );

    const report = section(result, "devops").mcpServers;
    expect(report.skipped).toEqual([
      { name: "memory", reason: "managed-url", detail: "http://127.0.0.1:9101/mcp" },
    ]);
    // The address was the only difference, so nothing else was written.
    expect(report.unchanged).toEqual(["memory"]);
    expect(mcps.patched).toEqual([]);
  });

  it("classifies the use case's refusals and rethrows anything else", async () => {
    const refuse = {
      taken: new ConflictError("taken"),
      blocked: new ValidationError("Blocked URL"),
    };
    const { deps } = makeDeps({ refuse });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          mcpJsonRaw: mcpJson({ taken: httpServer(), blocked: httpServer() }),
        }),
      ]),
      ACTOR,
    );
    expect(section(result, "devops").mcpServers.skipped).toEqual([
      { name: "taken", reason: "conflict" },
      { name: "blocked", reason: "invalid-url", detail: "Blocked URL" },
    ]);

    const { deps: failing } = makeDeps({ refuse: { boom: new Error("storage down") } });
    await expect(
      syncPluginsFromSnapshot(
        failing,
        snapshot([repoPlugin("devops", { mcpJsonRaw: mcpJson({ boom: httpServer() }) })]),
        ACTOR,
      ),
    ).rejects.toThrow("storage down");
  });

  it("carries the collector's attachment skips and bad skill directories", async () => {
    const { deps } = makeDeps();
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          badSkillDirs: ["plugins/devops/skills/Not A Slug/SKILL.md"],
          skippedAttachments: [{ name: "gitops", path: "scripts/run.sh", reason: "unsupported-type" }],
        }),
      ]),
      ACTOR,
    );

    expect(section(result, "devops").skills.skipped).toEqual([
      { name: "plugins/devops/skills/Not A Slug/SKILL.md", reason: "bad-name" },
      { name: "gitops", reason: "attachment", detail: "scripts/run.sh: unsupported-type" },
    ]);
  });

  it("orphans by plugin, synthesizing a section for one that vanished, and removes only what is named", async () => {
    const { deps, skills, mcps } = makeDeps({
      skills: [storedSkill("kept", { source: `github:${REPO}#devops` })],
      servers: [storedServer("gone-server", { source: `github:${REPO}#vanished` })],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops")]),
      ACTOR,
      { remove: { mcpServers: ["gone-server"] } },
    );

    expect(section(result, "devops").skills.orphaned).toEqual(["kept"]);
    expect(section(result, "vanished").mcpServers.removed).toEqual(["gone-server"]);
    expect(skills.removed).toEqual([]);
    expect(mcps.removed).toEqual([{ name: "gone-server", actor: ACTOR }]);
  });

  it("does not orphan an entry another plugin now claims — that is a takeover", async () => {
    const { deps } = makeDeps({
      skills: [storedSkill("moved", { source: `github:${REPO}#devops` })],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops"),
        repoPlugin("research", { skills: [repoSkill("research", "moved")] }),
      ]),
      ACTOR,
    );

    expect(section(result, "devops").skills.orphaned).toEqual([]);
    expect(section(result, "research").skills.overwritten).toEqual(["moved"]);
  });

  it("does not orphan an entry whose declared document failed conformance this round", async () => {
    const { deps } = makeDeps({
      skills: [storedSkill("gitops", { source: `github:${REPO}#devops` })],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          skills: [repoSkill("devops", "gitops", skillDoc("wrong-name"))],
        }),
      ]),
      ACTOR,
    );

    // Declared, though invalid: a frontmatter typo must not put a delete prompt
    // next to a stored entry.
    expect(section(result, "devops").skills.orphaned).toEqual([]);
    expect(section(result, "devops").skills.skipped[0]?.reason).toBe("invalid-skill");
  });

  it("upserts the plugin row every sync, keeping only createdAt", async () => {
    const row: Plugin = {
      name: "devops",
      repo: REPO,
      rootPath: "plugins/devops",
      commitSha: "old-sha",
      skills: [],
      mcpServers: [],
      syncedAt: BEFORE,
      createdAt: BEFORE,
      updatedAt: BEFORE,
    };
    const { deps, plugins } = makeDeps({ pluginRows: [row] });
    await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          manifestRaw: manifest("devops", { version: "1.2.0", description: "DevOps bundle" }),
          skills: [repoSkill("devops", "gitops")],
          mcpJsonRaw: mcpJson({ argocd: httpServer(), local: { type: "stdio", command: "x" } }),
        }),
      ]),
      ACTOR,
    );

    expect(plugins.puts).toEqual([
      {
        name: "devops",
        version: "1.2.0",
        description: "DevOps bundle",
        repo: REPO,
        rootPath: "plugins/devops",
        commitSha: "abc123",
        skills: ["gitops"],
        // Only the accepted transport counts as declared.
        mcpServers: ["argocd"],
        syncedAt: NOW,
        createdAt: BEFORE,
        updatedAt: NOW,
      },
    ]);
  });

  it("orphans a plugin row the snapshot no longer carries and removes it only when named", async () => {
    const row: Plugin = {
      name: "retired",
      repo: REPO,
      rootPath: "plugins/retired",
      commitSha: "old",
      skills: [],
      mcpServers: [],
      syncedAt: BEFORE,
      createdAt: BEFORE,
      updatedAt: BEFORE,
    };
    const { deps, plugins } = makeDeps({ pluginRows: [row] });

    const reported = await syncPluginsFromSnapshot(deps, snapshot([repoPlugin("devops")]), ACTOR);
    expect(reported.orphanedPlugins).toEqual(["retired"]);
    expect(plugins.removed).toEqual([]);

    const applied = await syncPluginsFromSnapshot(deps, snapshot([repoPlugin("devops")]), ACTOR, {
      remove: { plugins: ["retired"] },
    });
    expect(applied.removedPlugins).toEqual(["retired"]);
    expect(plugins.removed).toEqual([{ name: "retired", actor: ACTOR }]);
  });

  it("leaves another repo's plugin rows alone", async () => {
    const row: Plugin = {
      name: "elsewhere",
      repo: "other/repo",
      rootPath: "",
      commitSha: "x",
      skills: [],
      mcpServers: [],
      syncedAt: BEFORE,
      createdAt: BEFORE,
      updatedAt: BEFORE,
    };
    const { deps } = makeDeps({ pluginRows: [row] });
    const result = await syncPluginsFromSnapshot(deps, snapshot([repoPlugin("devops")]), ACTOR);
    expect(result.orphanedPlugins).toEqual([]);
  });
});
