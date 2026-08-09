"use client";

import { useState } from "react";
import { Alert, Button, Checkbox, Divider, Group, Stack, Text } from "@mantine/core";
import type { SyncSkip } from "@/domain/sync/types";
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
  conflict: "already registered by hand; the repository never touches it",
  attachment: "an attachment file was not carried",
  "invalid-manifest": "the manifest could not be used",
  "invalid-skill": "SKILL.md does not conform to the Agent Skills spec",
  "unsupported-transport": "a transport this deployment never runs",
  "headers-dropped": "synced without its declared headers — credentials are set in the console",
  "duplicate-name": "more than one plugin claims this name",
};

function toggle(list: string[], name: string): string[] {
  return list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name];
}

/**
 * The outcome of a plugins sync. The repository's content applied itself —
 * created and overwritten are records, not proposals — so the only decision
 * left here is deletion: entries the repository no longer carries, unticked by
 * default because an MCP entry may hold credentials.
 */
export function PluginSyncSummary({
  result,
  onApply,
}: {
  result: PluginSyncResult;
  /** Re-runs the sync with the chosen removals. */
  onApply: (selection: PluginSyncSelection) => Promise<void>;
}) {
  const [removeSkills, setRemoveSkills] = useState<string[]>([]);
  const [removeServers, setRemoveServers] = useState<string[]>([]);
  const [removePlugins, setRemovePlugins] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  const totals = { created: 0, overwritten: 0, unchanged: 0, removed: 0, skipped: result.skipped.length };
  for (const section of result.plugins) {
    for (const report of [section.skills, section.mcpServers]) {
      totals.created += report.created.length;
      totals.overwritten += report.overwritten.length;
      totals.unchanged += report.unchanged.length;
      totals.removed += report.removed.length;
      totals.skipped += report.skipped.length;
    }
  }
  const chosen = removeSkills.length + removeServers.length + removePlugins.length;
  const attention =
    totals.skipped > 0 ||
    result.orphanedPlugins.length > 0 ||
    result.plugins.some((section) =>
      [section.skills, section.mcpServers].some((report) => report.orphaned.length > 0),
    );

  async function apply() {
    setApplying(true);
    try {
      await onApply({
        remove: {
          ...(removeSkills.length > 0 ? { skills: removeSkills } : {}),
          ...(removeServers.length > 0 ? { mcpServers: removeServers } : {}),
          ...(removePlugins.length > 0 ? { plugins: removePlugins } : {}),
        },
      });
      setRemoveSkills([]);
      setRemoveServers([]);
      setRemovePlugins([]);
    } finally {
      setApplying(false);
    }
  }

  function kindRows(
    label: string,
    report: PluginKindReport,
    picked: string[],
    setPicked: (next: string[]) => void,
  ) {
    if (report.orphaned.length === 0 && report.skipped.length === 0) {
      return null;
    }
    return (
      <Stack gap={4}>
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
                checked={picked.includes(name)}
                onChange={() => setPicked(toggle(picked, name))}
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
          {totals.overwritten > 0 ? ` · updated ${totals.overwritten}` : ""}
          {totals.removed > 0 ? ` · deleted ${totals.removed}` : ""}
          {` · unchanged ${totals.unchanged}`}
          {totals.skipped > 0 ? ` · skipped ${totals.skipped}` : ""}
        </Text>

        {result.skipped.map((skip) => (
          <Text key={`${skip.name}-${skip.reason}`} fz="xs">
            {skip.name} — {SKIP_REASONS[skip.reason]}
            {skip.detail ? `: ${skip.detail}` : ""}
          </Text>
        ))}

        {result.plugins.map((section) => {
          const skillRows = kindRows("skills", section.skills, removeSkills, setRemoveSkills);
          const serverRows = kindRows(
            "MCP servers",
            section.mcpServers,
            removeServers,
            setRemoveServers,
          );
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
                checked={removePlugins.includes(name)}
                onChange={() => setRemovePlugins(toggle(removePlugins, name))}
                label={name}
              />
            ))}
          </Stack>
        )}

        {chosen > 0 && (
          <Group>
            <Button size="xs" loading={applying} onClick={() => void apply()}>
              Delete {chosen} entr{chosen === 1 ? "y" : "ies"}
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}
