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
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { setAuditSink } from "@/application/audit/recordAudit";
import type { AuditEvent } from "@/domain/audit/types";

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

    expect(section(result, "devops").skills.overwritten).toEqual([
      { name: "gitops", fields: ["content"] },
    ]);
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

    expect(section(result, "devops").skills.overwritten).toEqual([
      { name: "gitops", fields: ["source"] },
    ]);
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

    expect(section(result, "devops").mcpServers.overwritten).toEqual([
      { name: "argocd", fields: ["source"] },
    ]);
    expect(mcps.patched).toEqual([
      { name: "argocd", patch: { source: `github:${REPO}#devops` } },
    ]);
  });

  it("adopts a source-less entry whose name a plugin declares — the name is the repository's", async () => {
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
    expect(devops.skills.overwritten).toEqual([{ name: "gitops", fields: ["source"] }]);
    expect(devops.mcpServers.overwritten).toEqual([{ name: "argocd", fields: ["source"] }]);
    expect(skills.puts[0]).toMatchObject({
      source: `github:${REPO}#devops`,
      createdAt: BEFORE,
    });
    expect(mcps.patched).toEqual([
      { name: "argocd", patch: { source: `github:${REPO}#devops` } },
    ]);
  });

  it("leaves a hand-registered entry alone when no plugin declares its name", async () => {
    const { deps, skills, mcps } = makeDeps({
      skills: [storedSkill("mine", { source: undefined })],
      servers: [storedServer("also-mine", { source: undefined })],
    });
    const result = await syncPluginsFromSnapshot(deps, snapshot([repoPlugin("devops")]), ACTOR);

    // Not claimed, not orphaned, not written — the repository never named it.
    expect(section(result, "devops").skills.orphaned).toEqual([]);
    expect(section(result, "devops").mcpServers.orphaned).toEqual([]);
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

  it("clears a repo-owned description whose extension document is gone", async () => {
    // The entry is already this plugin's; the repo removing its document means
    // the stored description no longer has a source — it clears rather than
    // outliving it.
    const { deps, mcps } = makeDeps({
      servers: [storedServer("argocd", { description: "from the old doc" })],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { mcpJsonRaw: mcpJson({ argocd: httpServer() }) })]),
      ACTOR,
    );

    expect(section(result, "devops").mcpServers.overwritten).toEqual([
      { name: "argocd", fields: ["description"] },
    ]);
    expect(mcps.patched).toEqual([{ name: "argocd", patch: { description: "" } }]);
  });

  it("keeps a stored description through an adoption that carries no document", async () => {
    // Still changing hands: the entry keeps what it had until the repo
    // provides its own document.
    const { deps, mcps } = makeDeps({
      servers: [
        storedServer("argocd", { source: undefined, description: "typed by an operator" }),
      ],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { mcpJsonRaw: mcpJson({ argocd: httpServer() }) })]),
      ACTOR,
    );

    expect(section(result, "devops").mcpServers.overwritten).toEqual([
      { name: "argocd", fields: ["source"] },
    ]);
    expect(mcps.patched).toEqual([
      { name: "argocd", patch: { source: `github:${REPO}#devops` } },
    ]);
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

  it("classifies the use case's refusals and fences everything else as a skip", async () => {
    const refuse = {
      taken: new ConflictError("taken"),
      blocked: new ValidationError("Blocked URL"),
      vanished: new NotFoundError("gone"),
    };
    const { deps } = makeDeps({ refuse });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          mcpJsonRaw: mcpJson({ taken: httpServer(), blocked: httpServer(), vanished: httpServer() }),
        }),
      ]),
      ACTOR,
    );
    expect(section(result, "devops").mcpServers.skipped).toEqual([
      { name: "taken", reason: "conflict" },
      { name: "blocked", reason: "invalid-url", detail: "Blocked URL" },
      { name: "vanished", reason: "conflict", detail: "removed mid-sync" },
    ]);

    // A fault with no name is fenced, not fatal: the sync finishes and the
    // healthy sibling still lands.
    const { deps: failing, mcps } = makeDeps({ refuse: { boom: new Error("storage down") } });
    const fenced = await syncPluginsFromSnapshot(
      failing,
      snapshot([
        repoPlugin("devops", { mcpJsonRaw: mcpJson({ boom: httpServer(), fine: httpServer() }) }),
      ]),
      ACTOR,
    );
    expect(section(fenced, "devops").mcpServers.skipped).toEqual([
      { name: "boom", reason: "write-failed", detail: "storage down" },
    ]);
    expect(section(fenced, "devops").mcpServers.created).toEqual(["fine"]);
    expect(mcps.created.map((input) => input.name)).toEqual(["fine"]);
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

    expect(section(result, "devops").skills.orphaned).toEqual([{ name: "kept", boundTo: [] }]);
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
    expect(section(result, "research").skills.overwritten).toEqual([
      { name: "moved", fields: ["source"] },
    ]);
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

  it("reports dropped credentials when the repository moves a server's address", async () => {
    // The use case drops stored headers and OAuth on a URL move; the sync's
    // job is to say so where the operator is looking, and to still send the
    // move — the repo decides where an entry points, never what it may
    // authenticate as.
    const { deps, mcps } = makeDeps({
      servers: [
        storedServer("github", {
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "enc:v1:…" },
          auth: { type: "oauth2" } as never,
        }),
      ],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          mcpJsonRaw: mcpJson({ github: httpServer("https://elsewhere.test/mcp") }),
        }),
      ]),
      ACTOR,
    );

    const report = section(result, "devops").mcpServers;
    expect(report.overwritten).toEqual([{ name: "github", fields: ["url"] }]);
    expect(report.skipped).toEqual([
      {
        name: "github",
        reason: "credentials-reset",
        detail: "moved to https://elsewhere.test/mcp; dropped 1 header(s) and OAuth",
      },
    ]);
    expect(mcps.patched).toEqual([
      { name: "github", patch: { url: "https://elsewhere.test/mcp" } },
    ]);
  });

  it("adopts a source-less managed entry with a source-only patch", async () => {
    const { deps, mcps } = makeDeps({
      servers: [
        storedServer("memory", {
          source: undefined,
          runtime: "managed",
          url: "http://127.0.0.1:9101/mcp",
        }),
      ],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("agent-craft", {
          mcpJsonRaw: mcpJson({ memory: httpServer("http://mcp-memory.svc/mcp") }),
        }),
      ]),
      ACTOR,
    );

    const report = section(result, "agent-craft").mcpServers;
    expect(report.overwritten).toEqual([{ name: "memory", fields: ["source"] }]);
    expect(report.skipped).toEqual([
      { name: "memory", reason: "managed-url", detail: "http://127.0.0.1:9101/mcp" },
    ]);
    expect(mcps.patched).toEqual([
      { name: "memory", patch: { source: `github:${REPO}#agent-craft` } },
    ]);
  });

  it("routes a managed orphan's removal through the managed use case, or refuses without it", async () => {
    const managedRemoved: Array<{ name: string; actor: string }> = [];
    const base = {
      servers: [
        storedServer("memory", { runtime: "managed", source: `github:${REPO}#agent-craft` }),
      ],
    };

    // With the managed runtime available, the removal stops the container too.
    const withManaged = makeDeps(base);
    const routed = await syncPluginsFromSnapshot(
      { ...withManaged.deps, managedMcps: { remove: async (name, actor) => {
        managedRemoved.push({ name, actor });
      } } },
      snapshot([repoPlugin("agent-craft")]),
      ACTOR,
      { remove: { mcpServers: ["memory"] } },
    );
    expect(section(routed, "agent-craft").mcpServers.removed).toEqual(["memory"]);
    expect(managedRemoved).toEqual([{ name: "memory", actor: ACTOR }]);
    expect(withManaged.mcps.removed).toEqual([]);

    // Without it, deleting only the row would leave the container running
    // with nothing left that remembers it — refused and said so.
    const withoutManaged = makeDeps(base);
    const refused = await syncPluginsFromSnapshot(
      withoutManaged.deps,
      snapshot([repoPlugin("agent-craft")]),
      ACTOR,
      { remove: { mcpServers: ["memory"] } },
    );
    expect(section(refused, "agent-craft").mcpServers.removed).toEqual([]);
    expect(section(refused, "agent-craft").mcpServers.skipped[0]).toMatchObject({
      name: "memory",
      reason: "write-failed",
    });
    expect(withoutManaged.mcps.removed).toEqual([]);
  });

  it("replaces a skill's stored attachments with the repository's", async () => {
    const { deps, skills } = makeDeps({
      skills: [
        storedSkill("gitops", {
          files: [{ path: "references/old.md", content: "old" }],
        }),
      ],
    });
    const repoFiles = [{ path: "references/new.md", content: "new" }];
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([
        repoPlugin("devops", {
          skills: [{ ...repoSkill("devops", "gitops"), files: repoFiles }],
        }),
      ]),
      ACTOR,
    );

    expect(section(result, "devops").skills.overwritten).toEqual([
      { name: "gitops", fields: ["files"] },
    ]);
    expect(skills.puts[0]?.files).toEqual(repoFiles);
  });

  it("freezes a plugin whose mcp.json broke — previous servers stay claimed, the row keeps them", async () => {
    const row: Plugin = {
      name: "devops",
      repo: REPO,
      rootPath: "plugins/devops",
      commitSha: "old-sha",
      skills: [],
      mcpServers: ["argocd"],
      syncedAt: BEFORE,
      createdAt: BEFORE,
      updatedAt: BEFORE,
    };
    const { deps, plugins, mcps } = makeDeps({
      servers: [storedServer("argocd")],
      pluginRows: [row],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { mcpJsonRaw: "{broken" })]),
      ACTOR,
      // Even named for removal: a trailing comma must not delete credentials.
      { remove: { mcpServers: ["argocd"] } },
    );

    expect(section(result, "devops").mcpServers.orphaned).toEqual([]);
    expect(section(result, "devops").mcpServers.removed).toEqual([]);
    expect(mcps.removed).toEqual([]);
    expect(plugins.puts[0]?.mcpServers).toEqual(["argocd"]);
  });

  it("freezes a plugin whose plugin.json broke — nothing orphans, the row stays", async () => {
    const row: Plugin = {
      name: "devops",
      repo: REPO,
      rootPath: "plugins/devops",
      commitSha: "old-sha",
      skills: ["gitops"],
      mcpServers: ["argocd"],
      syncedAt: BEFORE,
      createdAt: BEFORE,
      updatedAt: BEFORE,
    };
    const { deps, plugins, skills, mcps } = makeDeps({
      skills: [storedSkill("gitops", { source: `github:${REPO}#devops` })],
      servers: [storedServer("argocd", { source: `github:${REPO}#devops` })],
      pluginRows: [row],
    });
    const result = await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { manifestRaw: "{broken" })]),
      ACTOR,
      { remove: { skills: ["gitops"], mcpServers: ["argocd"], plugins: ["devops"] } },
    );

    expect(result.skipped[0]).toMatchObject({ reason: "invalid-manifest" });
    expect(result.orphanedPlugins).toEqual([]);
    expect(result.removedPlugins).toEqual([]);
    expect(skills.removed).toEqual([]);
    expect(mcps.removed).toEqual([]);
    expect(plugins.puts).toEqual([]);
    expect(plugins.store.get("devops")).toEqual(row);
  });

  it("writes the plugin row even when a component write fails", async () => {
    const { deps, plugins } = makeDeps({ refuse: { boom: new Error("storage down") } });
    await syncPluginsFromSnapshot(
      deps,
      snapshot([repoPlugin("devops", { mcpJsonRaw: mcpJson({ boom: httpServer() }) })]),
      ACTOR,
    );
    expect(plugins.puts).toHaveLength(1);
    expect(plugins.puts[0]?.mcpServers).toEqual(["boom"]);
  });

  it("annotates orphans with the versions that bind them", async () => {
    const { deps } = makeDeps({
      skills: [storedSkill("kept", { source: `github:${REPO}#devops` })],
    });
    const result = await syncPluginsFromSnapshot(
      {
        ...deps,
        findBindings: async (skillNames) => ({
          skills: Object.fromEntries(skillNames.map((name) => [name, ["bot/v1", "bot/v2"]])),
          mcpServers: {},
        }),
      },
      snapshot([repoPlugin("devops")]),
      ACTOR,
    );
    expect(section(result, "devops").skills.orphaned).toEqual([
      { name: "kept", boundTo: ["bot/v1", "bot/v2"] },
    ]);
  });

  it("records an adoption in the audit trail", async () => {
    const rows: AuditEvent[] = [];
    setAuditSink({
      append: async (event) => void rows.push(event),
      listByDay: async () => [],
    });
    try {
      const { deps } = makeDeps({
        skills: [storedSkill("gitops", { source: "github:opspresso/agent-skills" })],
        servers: [storedServer("argocd", { source: undefined })],
      });
      await syncPluginsFromSnapshot(
        deps,
        snapshot([
          repoPlugin("devops", {
            skills: [repoSkill("devops", "gitops")],
            mcpJsonRaw: mcpJson({ argocd: httpServer() }),
          }),
        ]),
        ACTOR,
      );
    } finally {
      setAuditSink(undefined);
    }

    expect(rows.map((row) => ({ action: row.action, target: row.target, detail: row.detail }))).toEqual([
      {
        action: "registry.adopt",
        target: "skill:gitops",
        detail: `github:opspresso/agent-skills → github:${REPO}#devops`,
      },
      {
        action: "registry.adopt",
        target: "mcp:argocd",
        detail: `hand-registered → github:${REPO}#devops`,
      },
    ]);
    expect(rows.every((row) => row.actorEmail === ACTOR)).toBe(true);
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
