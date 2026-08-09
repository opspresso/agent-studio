"use client";

import { useState } from "react";
import { Alert, Button, Checkbox, Divider, Group, Stack, Text } from "@mantine/core";
import type { SyncExisting, SyncSkip } from "@/domain/sync/types";
import type {
  PluginKindReport,
  PluginSyncResult,
  PluginSyncSelection,
} from "@/domain/plugin/sync";

/** What a skip means, in words an operator can act on. */
const SKIP_REASONS: Record<SyncSkip["reason"], string> = {
  "bad-name": "name is not a slug (lowercase letters, digits, hyphens)",
  "invalid-url": "url refused",
  "managed-url": "managed entry — its address comes from the provisioner, not the repo",
  conflict: "already registered and not this sync's to change",
  attachment: "an attachment file was not carried",
  "invalid-manifest": "the manifest could not be used",
  "invalid-skill": "SKILL.md does not conform to the Agent Skills spec",
  "unsupported-transport": "a transport this deployment never runs",
  "headers-dropped": "synced without its declared headers — credentials are set in the console",
  "duplicate-name": "more than one plugin claims this name",
};

/** Selection state for one kind, shared across every plugin's section. */
interface KindPick {
  overwrite: string[];
  remove: string[];
}

function toggle(list: string[], name: string): string[] {
  return list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name];
}

/**
 * The outcome of a plugins sync, and the decisions it deliberately did not
 * make — grouped by plugin, because the plugin is the unit an operator
 * reasons about, while the selections stay per component name.
 *
 * An entry whose diffs include `source` is a takeover: it was created by
 * another origin (the retired skills/tools repos, or a different plugin) and
 * ticking it adopts it — content and provenance both.
 */
export function PluginSyncSummary({
  result,
  onApply,
}: {
  result: PluginSyncResult;
  /** Re-runs the sync with the chosen names. */
  onApply: (selection: PluginSyncSelection) => Promise<void>;
}) {
  const [skills, setSkills] = useState<KindPick>({ overwrite: [], remove: [] });
  const [servers, setServers] = useState<KindPick>({ overwrite: [], remove: [] });
  const [plugins, setPlugins] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  const totals = { created: 0, overwritten: 0, removed: 0, existing: 0, skipped: result.skipped.length };
  for (const section of result.plugins) {
    for (const report of [section.skills, section.mcpServers]) {
      totals.created += report.created.length;
      totals.overwritten += report.overwritten.length;
      totals.removed += report.removed.length;
      totals.existing += report.existing.length;
      totals.skipped += report.skipped.length;
    }
  }
  const chosen =
    skills.overwrite.length +
    skills.remove.length +
    servers.overwrite.length +
    servers.remove.length +
    plugins.length;
  const attention =
    totals.skipped > 0 ||
    result.orphanedPlugins.length > 0 ||
    result.plugins.some(
      (section) =>
        [section.skills, section.mcpServers].some(
          (report) =>
            report.orphaned.length > 0 ||
            report.existing.some((entry) => entry.differs.length > 0),
        ),
    );

  async function apply() {
    setApplying(true);
    try {
      await onApply({
        ...(skills.overwrite.length + servers.overwrite.length > 0
          ? {
              overwrite: {
                ...(skills.overwrite.length > 0 ? { skills: skills.overwrite } : {}),
                ...(servers.overwrite.length > 0 ? { mcpServers: servers.overwrite } : {}),
              },
            }
          : {}),
        ...(skills.remove.length + servers.remove.length + plugins.length > 0
          ? {
              remove: {
                ...(skills.remove.length > 0 ? { skills: skills.remove } : {}),
                ...(servers.remove.length > 0 ? { mcpServers: servers.remove } : {}),
                ...(plugins.length > 0 ? { plugins } : {}),
              },
            }
          : {}),
      });
      setSkills({ overwrite: [], remove: [] });
      setServers({ overwrite: [], remove: [] });
      setPlugins([]);
    } finally {
      setApplying(false);
    }
  }

  function kindRows(
    label: string,
    report: PluginKindReport,
    pick: KindPick,
    setPick: (next: KindPick) => void,
  ) {
    const changed = report.existing.filter((entry) => entry.differs.length > 0);
    if (
      changed.length === 0 &&
      report.orphaned.length === 0 &&
      report.skipped.length === 0
    ) {
      return null;
    }
    return (
      <Stack gap={4}>
        {changed.length > 0 && (
          <>
            <Text fz="xs" c="dimmed">
              These {label} differ from the repository — ticked entries are replaced with the
              repository&apos;s version. A <b>source</b> diff is a takeover from another origin.
            </Text>
            {changed.map((entry: SyncExisting) => (
              <Checkbox
                key={`ow-${entry.name}`}
                size="xs"
                checked={pick.overwrite.includes(entry.name)}
                onChange={() => setPick({ ...pick, overwrite: toggle(pick.overwrite, entry.name) })}
                label={`${entry.name} — ${entry.differs.join(", ")}`}
              />
            ))}
          </>
        )}
        {report.orphaned.length > 0 && (
          <>
            <Text fz="xs" c="dimmed">
              These {label} came from this plugin and are no longer in it — ticked entries are
              deleted. Anything registered by hand is never listed here.
            </Text>
            {report.orphaned.map((name) => (
              <Checkbox
                key={`rm-${name}`}
                size="xs"
                checked={pick.remove.includes(name)}
                onChange={() => setPick({ ...pick, remove: toggle(pick.remove, name) })}
                label={name}
              />
            ))}
          </>
        )}
        {report.skipped.map((skip) => (
          <Text key={`${skip.name}-${skip.reason}`} fz="xs">
            {skip.name} — {SKIP_REASONS[skip.reason]}
            {skip.detail ? `: ${skip.detail}` : ""}
          </Text>
        ))}
      </Stack>
    );
  }

  return (
    <Alert color={attention ? "yellow" : "teal"} variant="light">
      <Stack gap="xs">
        <Text fz="sm">
          Imported {totals.created}
          {totals.overwritten > 0 ? ` · overwritten ${totals.overwritten}` : ""}
          {totals.removed > 0 ? ` · deleted ${totals.removed}` : ""}
          {` · already registered ${totals.existing}`}
          {totals.skipped > 0 ? ` · skipped ${totals.skipped}` : ""}
        </Text>

        {result.skipped.map((skip) => (
          <Text key={`${skip.name}-${skip.reason}`} fz="xs">
            {skip.name} — {SKIP_REASONS[skip.reason]}
            {skip.detail ? `: ${skip.detail}` : ""}
          </Text>
        ))}

        {result.plugins.map((section) => {
          const skillRows = kindRows("skills", section.skills, skills, setSkills);
          const serverRows = kindRows("MCP servers", section.mcpServers, servers, setServers);
          if (!skillRows && !serverRows) {
            return null;
          }
          return (
            <Stack key={section.plugin} gap={6}>
              <Divider
                label={`${section.plugin}${section.version ? ` v${section.version}` : ""}`}
                labelPosition="left"
              />
              {skillRows}
              {serverRows}
            </Stack>
          );
        })}

        {result.orphanedPlugins.length > 0 && (
          <Stack gap={4}>
            <Divider label="plugins" labelPosition="left" />
            <Text fz="xs" c="dimmed">
              These plugins are no longer in the repository — ticking one removes only its row;
              its components stay and are offered individually above.
            </Text>
            {result.orphanedPlugins.map((name) => (
              <Checkbox
                key={`plugin-${name}`}
                size="xs"
                checked={plugins.includes(name)}
                onChange={() => setPlugins(toggle(plugins, name))}
                label={name}
              />
            ))}
          </Stack>
        )}

        {chosen > 0 && (
          <Group>
            <Button size="xs" loading={applying} onClick={() => void apply()}>
              Apply {chosen} change{chosen === 1 ? "" : "s"}
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}
