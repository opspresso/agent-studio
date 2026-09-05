import type { Skill, SkillFile } from "@/domain/skill/types";
import type { SkillRepository } from "@/domain/skill/repository";
import type { SkillUseCases } from "@/application/skill/skillUseCases";
import type { McpUseCases, UpdateMcpInput } from "@/application/mcp/mcpUseCases";
import type { ManagedMcpUseCases } from "@/application/mcp/managedMcpUseCases";
import type { PluginRepository } from "@/domain/plugin/repository";
import type { PluginUseCases } from "./pluginUseCases";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { listRegistry, resolveRegistryUrlPatch } from "@/application/registry/registryUseCases";
import { parseFrontmatter } from "@/domain/plugin/frontmatter";
import { isSlug } from "@/domain/naming";
import { log } from "@/shared/logger";
import {
  classifyMcpJsonServer,
  parseMcpJson,
  parsePluginManifest,
  pluginSource,
  pluginSourcePrefix,
  type Plugin,
  type PluginManifest,
} from "@/domain/plugin/types";
import type {
  OrphanBindings,
  PluginKindReport,
  PluginsRepoSnapshot,
  PluginSyncResult,
  PluginSyncSection,
  PluginSyncSelection,
  RepoPlugin,
} from "@/domain/plugin/sync";
import type { McpServer } from "@/domain/mcp/types";
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
  return { created: [], overwritten: [], unchanged: [], orphaned: [], removed: [], skipped: [] };
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
  /**
   * Where a managed entry's deletion goes — the only remove that also stops
   * the container. Absent on a deployment that cannot run containers, in
   * which case a managed orphan is reported but never deleted here: deleting
   * only the row would leave the container running with nothing left that
   * remembers it.
   */
  managedMcps?: Pick<ManagedMcpUseCases, "remove">;
  /**
   * Which versions bind the names about to be offered for deletion — the
   * blast radius next to the delete checkbox. Optional because it needs the
   * project store; without it orphans report with no binding info.
   */
  findBindings?: (skills: string[], mcpServers: string[]) => Promise<OrphanBindings>;
}

/**
 * Pull the Agent Plugins repository into the registries.
 *
 * **The repository owns what it declared — by name.** An entry the sync
 * created, one it adopts from another origin (the retired skills/tools repos,
 * a different plugin), and one that predates provenance entirely (registered
 * by hand, no source) are all brought to the repository's version
 * automatically, provenance included — and every change of hands leaves a
 * `registry.adopt` audit row. What stays untouched is a hand-registered entry
 * whose name no plugin declares: the repository never claimed it.
 *
 * **Credentials never follow an address.** When the repository moves a
 * server's URL, the use case drops the stored headers and OAuth block rather
 * than send the old host's secrets to the new one, and the report says so
 * (`credentials-reset`). The repo decides where an entry points, never what
 * it may authenticate as.
 *
 * **An unreadable manifest freezes, it does not orphan.** A plugin whose
 * plugin.json or mcp.json fails to parse keeps its previous row's components
 * as claims, so a trailing comma cannot line the plugin's servers up under
 * delete checkboxes — the same reasoning that makes an invalid SKILL.md a
 * skip rather than an orphan.
 *
 * **One failure costs one entry.** Every write is fenced: a refused URL, a
 * mid-sync race, a storage error each become a skip on that name and the
 * sync continues. The next sync converges on whatever this one missed.
 *
 * **A person owns deletion.** What the repository no longer carries is only
 * reported, per plugin and with the versions that bind it, and deleted when
 * the selection names it — an MCP entry holds credentials, and a file
 * disappearing from a branch is not reason enough to destroy them.
 */
export async function syncPluginsFromSnapshot(
  deps: SyncPluginsDeps,
  snapshot: PluginsRepoSnapshot,
  /**
   * Who asked for the sync; a deletion or adoption it performs is recorded
   * against them. Required, and ahead of the optional selection, so a caller
   * cannot forget it and write an invented address into the audit trail.
   */
  actorEmail: string,
  selection: PluginSyncSelection = {},
): Promise<PluginSyncResult> {
  const repoPrefix = pluginSourcePrefix(snapshot.repo);
  const now = new Date().toISOString();
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
  const unreadableRoots: string[] = [];
  for (const plugin of snapshot.plugins) {
    const res = parsePluginManifest(plugin.manifestRaw);
    if (!res.ok) {
      repoSkips.push({
        name: plugin.rootPath === "" ? "plugin.json" : `${plugin.rootPath}/plugin.json`,
        reason: "invalid-manifest",
        detail: res.reason,
      });
      unreadableRoots.push(plugin.rootPath);
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
      unreadableRoots.push(...claimants.map((c) => c.plugin.rootPath));
      continue;
    }
    parsed.push(...claimants);
  }

  const storedRows = await listRegistry(deps.plugins);
  const rowsByName = new Map(storedRows.map((row) => [row.name, row]));

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
  const claim = (map: Map<string, string[]>, name: string, plugin: string) => {
    map.set(name, [...(map.get(name) ?? []), plugin]);
  };

  // An unreadable plugin.json (or a duplicated plugin name) freezes the
  // plugin at its previous state: the last good row's components stay claimed
  // and the row stays as it was. Without this, one bad commit turns a whole
  // plugin's servers — credentials and all — into delete candidates.
  const frozenRowNames = new Set<string>();
  for (const rootPath of unreadableRoots) {
    const row = storedRows.find(
      (candidate) => candidate.repo === snapshot.repo && candidate.rootPath === rootPath,
    );
    if (!row) {
      continue;
    }
    frozenRowNames.add(row.name);
    for (const name of row.skills) {
      claim(skillClaims, name, row.name);
    }
    for (const name of row.mcpServers) {
      claim(serverClaims, name, row.name);
    }
  }

  const parsedServers = new Map<string, Record<string, unknown>>();
  for (const { plugin, manifest } of parsed) {
    sectionFor(manifest.name, manifest);
    for (const skill of plugin.skills) {
      claim(skillClaims, skill.name, manifest.name);
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
      // Frozen, not forgotten: the previous row's servers stay claimed so a
      // broken mcp.json cannot orphan what it declared last time.
      for (const name of rowsByName.get(manifest.name)?.mcpServers ?? []) {
        claim(serverClaims, name, manifest.name);
      }
      continue;
    }
    parsedServers.set(manifest.name, res.servers);
    for (const name of Object.keys(res.servers)) {
      claim(serverClaims, name, manifest.name);
    }
  }

  const storedSkills = new Map(
    (await listRegistry(deps.skillRepo)).map((skill) => [skill.name, skill]),
  );
  const storedServers = new Map((await deps.mcps.list()).map((server) => [server.name, server]));

  /**
   * Run one write behind a fence: a failure becomes a skip on that name and
   * the sync continues. Known refusals keep their vocabulary; anything else
   * is `write-failed` with the message, and logged — a fence must not make a
   * storage fault quieter than a skipped attachment.
   */
  const fence = async (
    skips: SyncSkip[],
    name: string,
    op: () => Promise<unknown>,
  ): Promise<boolean> => {
    try {
      await op();
      return true;
    } catch (error) {
      const reported = classify(name, error);
      if (!reported) {
        log.error("plugins", `sync write for '${name}' failed`, error);
      }
      skips.push(
        reported ?? {
          name,
          reason: "write-failed",
          detail: error instanceof Error ? error.message : String(error),
        },
      );
      return false;
    }
  };

  const adopted = async (kind: "skill" | "mcp", name: string, oldSource: string | undefined, source: string) => {
    await recordAudit({
      actorEmail,
      action: "registry.adopt",
      target: auditTarget(kind, name),
      detail: `${oldSource ?? "hand-registered"} → ${source}`,
    });
  };

  for (const { plugin, manifest } of parsed) {
    const section = sectionFor(manifest.name);
    const source = pluginSource(snapshot.repo, manifest.name);
    const report = section.skills;
    const mcpReport = section.mcpServers;

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

    // Validate everything before writing anything, so the plugin row — which
    // records what the plugin declares — can be written first. A row written
    // last meant a mid-sync failure left components pointing at a plugin page
    // that answered 404.
    const conformantSkills: Array<{ name: string; doc: ParsedPluginSkillDoc; files?: SkillFile[] }> = [];
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
      conformantSkills.push({
        name: file.name,
        doc: parsedDoc.doc,
        files: file.files.length > 0 ? file.files : undefined,
      });
    }

    const acceptedServers: Array<{
      name: string;
      url: string;
      doc: { description?: string; content?: string };
    }> = [];
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
      acceptedServers.push({ name, url: classified.url, doc: doc ? parseMcpDoc(doc.content) : {} });
    }

    const existingRow = rowsByName.get(manifest.name);
    const declaredServers =
      plugin.mcpJsonRaw !== undefined && servers === undefined
        ? // mcp.json unreadable: freeze the previous declaration.
          existingRow?.mcpServers ?? []
        : acceptedServers.map((server) => server.name);
    const row: Plugin = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      repo: snapshot.repo,
      branch: snapshot.branch,
      rootPath: plugin.rootPath,
      commitSha: snapshot.commitSha,
      skills: conformantSkills.map((skill) => skill.name),
      mcpServers: declaredServers,
      syncedAt: now,
      createdAt: existingRow?.createdAt ?? now,
      updatedAt: now,
    };
    const pluginWritten = await fence(
      repoSkips,
      `plugin:${manifest.name}`,
      () => deps.plugins.put(row),
    );
    if (!pluginWritten) {
      continue;
    }

    for (const { name, doc, files } of conformantSkills) {
      const current = storedSkills.get(name);
      if (!current) {
        const created: Skill = {
          name,
          description: doc.description,
          content: doc.body,
          files,
          source,
          createdAt: now,
          updatedAt: now,
        };
        if (await fence(report.skipped, name, () => deps.skillRepo.put(created))) {
          report.created.push(name);
        }
        continue;
      }
      const fields = [
        ...(current.source !== source ? ["source"] : []),
        ...(current.description !== doc.description ? ["description"] : []),
        ...(current.content !== doc.body ? ["content"] : []),
        ...(sameFiles(current.files, files) ? [] : ["files"]),
      ];
      if (fields.length === 0) {
        // Nothing is written for an entry that already agrees, or `updatedAt`
        // would move on every sync and make the registry look edited.
        report.unchanged.push(name);
        continue;
      }
      const next: Skill = {
        name,
        description: doc.description,
        content: doc.body,
        files,
        source,
        createdAt: current.createdAt,
        updatedAt: now,
      };
      if (await fence(report.skipped, name, () => deps.skillRepo.put(next))) {
        report.overwritten.push({ name, fields });
        if (current.source !== source) {
          await adopted("skill", name, current.source, source);
        }
      }
    }

    for (const { name, url, doc } of acceptedServers) {
      const current = storedServers.get(name);
      if (!current) {
        if (
          await fence(mcpReport.skipped, name, async () => {
            const created = await deps.mcps.create({
              name,
              url,
              description: doc.description,
              content: doc.content,
              source,
              // Never from the repository: a secret does not belong in git, so
              // a server that needs one is registered here and credentialed in
              // the console.
              headers: {},
            });
            storedServers.set(name, created);
          })
        ) {
          mcpReport.created.push(name);
        }
        continue;
      }
      // A managed entry's address is the basis for trusting it, and the use
      // case refuses to move one. Left out of the patch so the rest of the
      // document can still apply, and reported either way.
      const managed = current.runtime === "managed";
      const urlDiffers = resolveRegistryUrlPatch(current.url, url) !== current.url;
      // A document the repository no longer carries no longer describes the
      // server: for an entry that is already this plugin's, the stored
      // description and notes clear rather than outlive their source. An entry
      // still changing hands keeps what it had until the repo provides one.
      const ours = current.source === source;
      const description = doc.description ?? (ours && current.description ? "" : undefined);
      const content = doc.content ?? (ours && current.content ? "" : undefined);
      const patch: UpdateMcpInput = {
        ...(urlDiffers && !managed ? { url } : {}),
        ...(description !== undefined && description !== current.description ? { description } : {}),
        ...(content !== undefined && content !== current.content ? { content } : {}),
        ...(current.source !== source ? { source } : {}),
      };
      if (urlDiffers && managed) {
        mcpReport.skipped.push({ name, reason: "managed-url", detail: current.url });
      }
      if (Object.keys(patch).length === 0) {
        mcpReport.unchanged.push(name);
        continue;
      }
      // Moving the address costs the credentials entered for the old one —
      // the use case drops stored headers and any OAuth block rather than
      // send them to whatever the repository now points at. Reported here,
      // where the operator who must re-enter them is looking.
      if (patch.url !== undefined && (Object.keys(current.headers).length > 0 || current.auth)) {
        const lost = [
          ...(Object.keys(current.headers).length > 0
            ? [`${Object.keys(current.headers).length} header(s)`]
            : []),
          ...(current.auth ? ["OAuth"] : []),
        ];
        mcpReport.skipped.push({
          name,
          reason: "credentials-reset",
          detail: `moved to ${patch.url}; dropped ${lost.join(" and ")}`,
        });
      }
      if (await fence(mcpReport.skipped, name, () => deps.mcps.update(name, patch))) {
        mcpReport.overwritten.push({ name, fields: Object.keys(patch) });
        if (current.source !== source) {
          await adopted("mcp", name, current.source, source);
        }
      }
    }
  }

  // Orphans, by provenance prefix. A component that moved between plugins is
  // claimed under its new plugin — a takeover, not an orphan — so only a name
  // no plugin declares at all lands here, attributed to the plugin its stored
  // source still names (a section is synthesized for one that vanished).
  const orphanSkills: Array<{ skill: Skill; report: PluginKindReport }> = [];
  const orphanServers: Array<{ server: McpServer; report: PluginKindReport }> = [];
  for (const skill of storedSkills.values()) {
    if (!skill.source?.startsWith(repoPrefix) || skillClaims.has(skill.name)) {
      continue;
    }
    const report = sectionFor(skill.source.slice(repoPrefix.length)).skills;
    if (!removeSkills.has(skill.name)) {
      orphanSkills.push({ skill, report });
      continue;
    }
    if (await fence(report.skipped, skill.name, () => deps.skills.remove(skill.name, actorEmail))) {
      report.removed.push(skill.name);
    }
  }
  for (const server of storedServers.values()) {
    if (!server.source?.startsWith(repoPrefix) || serverClaims.has(server.name)) {
      continue;
    }
    const report = sectionFor(server.source.slice(repoPrefix.length)).mcpServers;
    if (!removeServers.has(server.name)) {
      orphanServers.push({ server, report });
      continue;
    }
    if (server.runtime === "managed") {
      // Only the managed use case also stops the container. Without it,
      // deleting the row would leave the workload running with nothing left
      // that remembers it — so on a deployment that cannot reach it, the
      // orphan stays reported instead.
      if (!deps.managedMcps) {
        report.skipped.push({
          name: server.name,
          reason: "write-failed",
          detail:
            "managed entry; the managed runtime is not configured here, so its container cannot be stopped",
        });
        continue;
      }
      const managedMcps = deps.managedMcps;
      if (
        await fence(report.skipped, server.name, () => managedMcps.remove(server.name, actorEmail))
      ) {
        report.removed.push(server.name);
      }
      continue;
    }
    if (await fence(report.skipped, server.name, () => deps.mcps.remove(server.name, actorEmail))) {
      report.removed.push(server.name);
    }
  }

  // The delete checkbox gets its blast radius: which versions bind each
  // orphan. One batched lookup, only when there is an orphan to annotate.
  let bindings: OrphanBindings = { skills: {}, mcpServers: {} };
  if (deps.findBindings && (orphanSkills.length > 0 || orphanServers.length > 0)) {
    try {
      bindings = await deps.findBindings(
        orphanSkills.map((entry) => entry.skill.name),
        orphanServers.map((entry) => entry.server.name),
      );
    } catch (error) {
      // The annotation is advisory; losing it must not lose the report.
      log.error("plugins", "binding lookup for orphans failed", error);
    }
  }
  for (const { skill, report } of orphanSkills) {
    report.orphaned.push({ name: skill.name, boundTo: bindings.skills[skill.name] ?? [] });
  }
  for (const { server, report } of orphanServers) {
    report.orphaned.push({ name: server.name, boundTo: bindings.mcpServers[server.name] ?? [] });
  }

  // Plugin rows the snapshot no longer carries. Removing one does not cascade:
  // its components surface individually above, each its own decision. A row
  // frozen by an unreadable manifest is present, not gone — never offered.
  const parsedNames = new Set(parsed.map((candidate) => candidate.manifest.name));
  const orphanedPlugins: string[] = [];
  const removedPlugins: string[] = [];
  for (const row of storedRows) {
    if (row.repo !== snapshot.repo || parsedNames.has(row.name) || frozenRowNames.has(row.name)) {
      continue;
    }
    if (!removePlugins.has(row.name)) {
      orphanedPlugins.push(row.name);
      continue;
    }
    if (await fence(repoSkips, `plugin:${row.name}`, () => deps.pluginRows.remove(row.name, actorEmail))) {
      removedPlugins.push(row.name);
    }
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
 * Turn a write failure into the vocabulary the report already speaks, or
 * `null` for a fault with no name yet — the fence files those as
 * `write-failed` with the message, so nothing aborts the sync.
 */
function classify(name: string, error: unknown): SyncSkip | null {
  if (error instanceof ConflictError) {
    return { name, reason: "conflict" };
  }
  if (error instanceof NotFoundError) {
    // The mirror race of `conflict`: the entry vanished between reading the
    // registry and writing. The next sync finds whatever is true by then.
    return { name, reason: "conflict", detail: "removed mid-sync" };
  }
  if (error instanceof ValidationError) {
    return { name, reason: "invalid-url", detail: error.message };
  }
  return null;
}
