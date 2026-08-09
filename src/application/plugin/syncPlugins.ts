import type { SkillFile } from "@/domain/skill/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { SkillUseCases } from "@/application/skill/skillUseCases";
import type { McpUseCases, UpdateMcpInput } from "@/application/mcp/mcpUseCases";
import type { PluginRepository } from "@/domain/plugin/repository";
import type { PluginUseCases } from "./pluginUseCases";
import { ConflictError, ValidationError } from "@/application/errors";
import { parseFrontmatter } from "@/shared/frontmatter";
import { isSlug } from "@/shared/slug";
import {
  classifyMcpJsonServer,
  parseMcpJson,
  parsePluginManifest,
  type PluginManifest,
} from "@/domain/plugin/types";
import type {
  PluginKindReport,
  PluginsRepoSnapshot,
  PluginSyncResult,
  PluginSyncSection,
  PluginSyncSelection,
  RepoPlugin,
} from "@/domain/plugin/sync";
import type { SyncSkip } from "@/domain/sync/types";

/** The Agent Skills spec's description cap. */
const MAX_SKILL_DESCRIPTION = 1024;

export interface ParsedPluginSkillDoc {
  description: string;
  body: string;
}

/**
 * Parse a plugin skill's SKILL.md against the Agent Skills spec's frontmatter
 * contract. Stricter than the legacy skills sync on purpose: the spec requires
 * `name` to match the directory and `description` to exist, so a document that
 * fails either is reported rather than imported under a guessed description.
 */
export function parsePluginSkillDoc(
  dirName: string,
  raw: string,
): { ok: true; doc: ParsedPluginSkillDoc } | { ok: false; reason: string } {
  const { fields, body } = parseFrontmatter(raw);
  if (fields.name !== dirName) {
    return {
      ok: false,
      reason: fields.name
        ? `frontmatter name "${fields.name}" does not match the directory "${dirName}"`
        : "frontmatter is missing the required name field",
    };
  }
  if (!fields.description) {
    return { ok: false, reason: "frontmatter is missing the required description field" };
  }
  if (fields.description.length > MAX_SKILL_DESCRIPTION) {
    return {
      ok: false,
      reason: `description is over the spec's ${MAX_SKILL_DESCRIPTION}-character cap`,
    };
  }
  return { ok: true, doc: { description: fields.description, body } };
}

/**
 * Parse an `org.opspresso.agent-studio/mcp/<server>.md` extension document:
 * the frontmatter `description` is the line the model sees, the body is
 * operator notes. No fallback description — the document's whole purpose is
 * to carry one, and inventing one from the body would report nothing lost.
 */
export function parseMcpDoc(raw: string): { description?: string; content?: string } {
  const { fields, body } = parseFrontmatter(raw);
  return {
    ...(fields.description ? { description: fields.description } : {}),
    ...(body ? { content: body } : {}),
  };
}

/** An empty attachment set and an absent one are the same skill. */
function sameFiles(a: SkillFile[] | undefined, b: SkillFile[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) {
    return false;
  }
  return left.every((file, index) => {
    const other = right[index];
    return other !== undefined && file.path === other.path && file.content === other.content;
  });
}

function emptyReport(): PluginKindReport {
  return { created: [], existing: [], overwritten: [], orphaned: [], removed: [], skipped: [] };
}

export interface SyncPluginsDeps {
  plugins: PluginRepository;
  /** Deletion of a plugin row goes through the use case for its audit trace. */
  pluginRows: Pick<PluginUseCases, "remove">;
  /**
   * Skills write straight to the repository — that is how `files` and `source`
   * survive, since the skill use case's create carries neither — while
   * deletion goes through the use case, the single owner of the
   * `registry.delete` row. The same asymmetry the legacy skills sync had, for
   * the same reasons.
   */
  skillRepo: SkillRepository;
  skills: Pick<SkillUseCases, "remove">;
  /**
   * Servers go through the use case both ways, so a synced entry faces exactly
   * the checks a typed one does — the name rule, the outbound URL guard.
   */
  mcps: Pick<McpUseCases, "list" | "create" | "update" | "remove">;
}

/**
 * Pull the Agent Plugins repository into the registries.
 *
 * The discipline is the one every sync here has: **import what is missing,
 * report everything else, act only on a named selection.** What is new is the
 * unit. Provenance is per plugin (`github:<repo>#<plugin>`), so orphaning,
 * takeover and the report are all plugin-scoped, and the selection is
 * kind-qualified because skills and MCP servers are different registries that
 * may hold the same name.
 *
 * **Takeover is an operator's decision.** An entry whose `source` names
 * another origin — the retired skills/tools repos, or a different plugin —
 * is reported as `existing` with `source` among its diffs; only an overwrite
 * naming it rewrites content *and* provenance. An entry with no source at all
 * was registered by hand and is never offered: it was never any repository's.
 *
 * **The plugin row is the one unconditional write.** It is a pure projection
 * of the repository — nothing on it is operator-authored — so gating its
 * refresh behind a selection would only let it go stale.
 */
export async function syncPluginsFromSnapshot(
  deps: SyncPluginsDeps,
  snapshot: PluginsRepoSnapshot,
  /**
   * Who asked for the sync; a deletion it performs is recorded against them.
   * Required, and ahead of the optional selection, so a caller cannot forget
   * it and write an invented address into the audit trail.
   */
  actorEmail: string,
  selection: PluginSyncSelection = {},
): Promise<PluginSyncResult> {
  const repoPrefix = `github:${snapshot.repo}#`;
  const now = new Date().toISOString();
  const overwriteSkills = new Set(selection.overwrite?.skills ?? []);
  const overwriteServers = new Set(selection.overwrite?.mcpServers ?? []);
  const removeSkills = new Set(selection.remove?.skills ?? []);
  const removeServers = new Set(selection.remove?.mcpServers ?? []);
  const removePlugins = new Set(selection.remove?.plugins ?? []);

  const repoSkips: SyncSkip[] = [];
  for (const path of snapshot.nestedRoots) {
    repoSkips.push({
      name: path,
      reason: "invalid-manifest",
      detail: "plugin root nested inside another plugin",
    });
  }

  const candidates: { plugin: RepoPlugin; manifest: PluginManifest }[] = [];
  for (const plugin of snapshot.plugins) {
    const res = parsePluginManifest(plugin.manifestRaw);
    if (!res.ok) {
      repoSkips.push({
        name: plugin.rootPath === "" ? "plugin.json" : `${plugin.rootPath}/plugin.json`,
        reason: "invalid-manifest",
        detail: res.reason,
      });
      continue;
    }
    candidates.push({ plugin, manifest: res.manifest });
  }

  // Two plugins with one name: every claimant is refused, because tree order
  // must not decide which one the registry means.
  const byName = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const list = byName.get(candidate.manifest.name) ?? [];
    list.push(candidate);
    byName.set(candidate.manifest.name, list);
  }
  const parsed: typeof candidates = [];
  for (const [name, claimants] of byName) {
    if (claimants.length > 1) {
      repoSkips.push({
        name,
        reason: "duplicate-name",
        detail: `declared at ${claimants.map((c) => c.plugin.rootPath || ".").join(", ")}`,
      });
      continue;
    }
    parsed.push(...claimants);
  }

  const sections = new Map<string, PluginSyncSection>();
  const sectionFor = (pluginName: string, manifest?: PluginManifest): PluginSyncSection => {
    let section = sections.get(pluginName);
    if (!section) {
      section = {
        plugin: pluginName,
        ...(manifest?.version ? { version: manifest.version } : {}),
        ...(manifest?.description ? { description: manifest.description } : {}),
        skills: emptyReport(),
        mcpServers: emptyReport(),
      };
      sections.set(pluginName, section);
    }
    return section;
  };

  // Claims are by declared name, valid or not: a document that fails
  // conformance this round still marks its name as the repository's, so the
  // stored entry is not offered for deletion over a frontmatter typo.
  const skillClaims = new Map<string, string[]>();
  const serverClaims = new Map<string, string[]>();
  const parsedServers = new Map<string, Record<string, unknown>>();
  for (const { plugin, manifest } of parsed) {
    sectionFor(manifest.name, manifest);
    for (const skill of plugin.skills) {
      skillClaims.set(skill.name, [...(skillClaims.get(skill.name) ?? []), manifest.name]);
    }
    if (plugin.mcpJsonRaw === undefined) {
      continue;
    }
    const res = parseMcpJson(plugin.mcpJsonRaw);
    if (!res.ok) {
      sectionFor(manifest.name).mcpServers.skipped.push({
        name: "mcp.json",
        reason: "invalid-manifest",
        detail: res.reason,
      });
      continue;
    }
    parsedServers.set(manifest.name, res.servers);
    for (const name of Object.keys(res.servers)) {
      serverClaims.set(name, [...(serverClaims.get(name) ?? []), manifest.name]);
    }
  }

  const storedSkills = new Map((await deps.skillRepo.list()).map((skill) => [skill.name, skill]));
  const storedServers = new Map((await deps.mcps.list()).map((server) => [server.name, server]));

  for (const { plugin, manifest } of parsed) {
    const section = sectionFor(manifest.name);
    const source = repoPrefix + manifest.name;
    const declaredSkills: string[] = [];
    const declaredServers: string[] = [];

    const report = section.skills;
    for (const path of plugin.badSkillDirs) {
      report.skipped.push({ name: path, reason: "bad-name" });
    }
    for (const attachment of plugin.skippedAttachments) {
      report.skipped.push({
        name: attachment.name,
        reason: "attachment",
        detail: `${attachment.path}: ${attachment.reason}`,
      });
    }

    for (const file of plugin.skills) {
      const claimants = skillClaims.get(file.name) ?? [];
      if (claimants.length > 1) {
        report.skipped.push({
          name: file.name,
          reason: "duplicate-name",
          detail: `also declared by ${claimants.filter((p) => p !== manifest.name).join(", ")}`,
        });
        continue;
      }
      const parsedDoc = parsePluginSkillDoc(file.name, file.content);
      if (!parsedDoc.ok) {
        report.skipped.push({ name: file.name, reason: "invalid-skill", detail: parsedDoc.reason });
        continue;
      }
      declaredSkills.push(file.name);
      const { description, body } = parsedDoc.doc;
      const files = file.files.length > 0 ? file.files : undefined;
      const current = storedSkills.get(file.name);

      if (!current) {
        await deps.skillRepo.put({
          name: file.name,
          description,
          content: body,
          files,
          source,
          createdAt: now,
          updatedAt: now,
        });
        report.created.push(file.name);
        continue;
      }
      if (!current.source) {
        report.skipped.push({
          name: file.name,
          reason: "conflict",
          detail: "registered by hand; not offered for overwrite",
        });
        continue;
      }
      const differs = [
        ...(current.source !== source ? ["source"] : []),
        ...(current.description !== description ? ["description"] : []),
        ...(current.content !== body ? ["content"] : []),
        ...(sameFiles(current.files, files) ? [] : ["files"]),
      ];
      if (!overwriteSkills.has(file.name) || differs.length === 0) {
        // Nothing is written for an entry the caller did not name — and nothing
        // for one that already agrees either, or `updatedAt` would move on
        // every sync and make the registry look edited.
        report.existing.push({ name: file.name, differs });
        continue;
      }
      await deps.skillRepo.put({
        name: file.name,
        description,
        content: body,
        files,
        source,
        createdAt: current.createdAt,
        updatedAt: now,
      });
      report.overwritten.push(file.name);
    }

    const mcpReport = section.mcpServers;
    const servers = parsedServers.get(manifest.name);
    for (const [name, entry] of Object.entries(servers ?? {})) {
      const claimants = serverClaims.get(name) ?? [];
      if (claimants.length > 1) {
        mcpReport.skipped.push({
          name,
          reason: "duplicate-name",
          detail: `also declared by ${claimants.filter((p) => p !== manifest.name).join(", ")}`,
        });
        continue;
      }
      if (!isSlug(name)) {
        mcpReport.skipped.push({ name, reason: "bad-name" });
        continue;
      }
      const classified = classifyMcpJsonServer(entry);
      if (classified.kind === "invalid") {
        mcpReport.skipped.push({ name, reason: "invalid-manifest", detail: classified.reason });
        continue;
      }
      if (classified.kind === "unsupported-transport") {
        mcpReport.skipped.push({
          name,
          reason: "unsupported-transport",
          detail: classified.transport,
        });
        continue;
      }
      declaredServers.push(name);
      if (classified.declaredHeaderNames.length > 0) {
        // The server still syncs; what was left behind is said out loud, by
        // name only — never a value.
        mcpReport.skipped.push({
          name,
          reason: "headers-dropped",
          detail: classified.declaredHeaderNames.join(", "),
        });
      }
      const doc = plugin.mcpDocs.find((candidate) => candidate.server === name);
      const parsedDoc = doc ? parseMcpDoc(doc.content) : {};
      const current = storedServers.get(name);

      if (!current) {
        try {
          const created = await deps.mcps.create({
            name,
            url: classified.url,
            description: parsedDoc.description,
            content: parsedDoc.content,
            source,
            // Never from the repository: a secret does not belong in git, so a
            // server that needs one is registered here and credentialed in the
            // console.
            headers: {},
          });
          mcpReport.created.push(name);
          storedServers.set(name, created);
        } catch (error) {
          const reported = classify(name, error);
          if (!reported) {
            throw error;
          }
          mcpReport.skipped.push(reported);
        }
        continue;
      }
      if (!current.source) {
        mcpReport.skipped.push({
          name,
          reason: "conflict",
          detail: "registered by hand; not offered for overwrite",
        });
        continue;
      }
      // A managed entry's address is the basis for trusting it, and the use
      // case refuses to move one. Left out of the patch so the rest of the
      // document can still apply, and reported either way.
      const managed = current.runtime === "managed";
      const urlDiffers = classified.url !== current.url;
      const patch: UpdateMcpInput = {
        ...(urlDiffers && !managed ? { url: classified.url } : {}),
        ...(parsedDoc.description && parsedDoc.description !== current.description
          ? { description: parsedDoc.description }
          : {}),
        ...(parsedDoc.content && parsedDoc.content !== current.content
          ? { content: parsedDoc.content }
          : {}),
        ...(current.source !== source ? { source } : {}),
      };
      const differs = Object.keys(patch);
      if (urlDiffers && managed) {
        mcpReport.skipped.push({ name, reason: "managed-url", detail: current.url });
      }
      if (!overwriteServers.has(name) || differs.length === 0) {
        mcpReport.existing.push({ name, differs });
        continue;
      }
      try {
        await deps.mcps.update(name, patch);
        mcpReport.overwritten.push(name);
      } catch (error) {
        const reported = classify(name, error);
        if (!reported) {
          throw error;
        }
        mcpReport.skipped.push(reported);
      }
    }

    // The row is a projection of what this sync just read, so it is refreshed
    // whether or not anything else was written; only `createdAt` survives.
    const existingRow = await deps.plugins.get(manifest.name);
    await deps.plugins.put({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      repo: snapshot.repo,
      rootPath: plugin.rootPath,
      commitSha: snapshot.commitSha,
      skills: declaredSkills,
      mcpServers: declaredServers,
      syncedAt: now,
      createdAt: existingRow?.createdAt ?? now,
      updatedAt: now,
    });
  }

  // Orphans, by provenance prefix. A component that moved between plugins is
  // claimed under its new plugin — a takeover, not an orphan — so only a name
  // no plugin declares at all lands here, attributed to the plugin its stored
  // source still names (a section is synthesized for one that vanished).
  for (const skill of storedSkills.values()) {
    if (!skill.source?.startsWith(repoPrefix) || skillClaims.has(skill.name)) {
      continue;
    }
    const section = sectionFor(skill.source.slice(repoPrefix.length));
    if (!removeSkills.has(skill.name)) {
      section.skills.orphaned.push(skill.name);
      continue;
    }
    await deps.skills.remove(skill.name, actorEmail);
    section.skills.removed.push(skill.name);
  }
  for (const server of storedServers.values()) {
    if (!server.source?.startsWith(repoPrefix) || serverClaims.has(server.name)) {
      continue;
    }
    const section = sectionFor(server.source.slice(repoPrefix.length));
    if (!removeServers.has(server.name)) {
      section.mcpServers.orphaned.push(server.name);
      continue;
    }
    await deps.mcps.remove(server.name, actorEmail);
    section.mcpServers.removed.push(server.name);
  }

  // Plugin rows the snapshot no longer carries. Removing one does not cascade:
  // its components surface individually above, each its own decision.
  const parsedNames = new Set(parsed.map((candidate) => candidate.manifest.name));
  const orphanedPlugins: string[] = [];
  const removedPlugins: string[] = [];
  for (const row of await deps.plugins.list()) {
    if (row.repo !== snapshot.repo || parsedNames.has(row.name)) {
      continue;
    }
    if (!removePlugins.has(row.name)) {
      orphanedPlugins.push(row.name);
      continue;
    }
    await deps.pluginRows.remove(row.name, actorEmail);
    removedPlugins.push(row.name);
  }

  return {
    repo: snapshot.repo,
    commitSha: snapshot.commitSha,
    plugins: [...sections.values()],
    skipped: repoSkips,
    orphanedPlugins,
    removedPlugins,
  };
}

/**
 * Turn a write failure into what the operator is told, or `null` when it is
 * not ours to explain — an unknown error is a bug and must reach the caller
 * rather than be filed as a skipped server.
 */
function classify(name: string, error: unknown): SyncSkip | null {
  if (error instanceof ConflictError) {
    return { name, reason: "conflict" };
  }
  if (error instanceof ValidationError) {
    return { name, reason: "invalid-url", detail: error.message };
  }
  return null;
}
