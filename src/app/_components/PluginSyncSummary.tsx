"use client";

import { useState } from "react";
import { Alert, Badge, Button, Checkbox, Divider, Group, Stack, Text } from "@mantine/core";
import type { SyncSkip } from "@/domain/sync/types";
import type {
  PluginKindReport,
  PluginSyncResult,
  PluginSyncSelection,
  SyncOrphan,
  SyncWrite,
} from "@/domain/plugin/sync";
import { BADGE } from "@/app/_components/badgeColors";
import { reportError } from "@/app/_lib/reportError";
import { useT } from "@/app/_i18n/provider";

/** What a skip means, in words an operator can act on. */
const SKIP_REASONS: Record<SyncSkip["reason"], string> = {
  "bad-name": "name is not a slug (lowercase letters, digits, hyphens)",
  "invalid-url": "url refused",
  "managed-url": "managed entry — its address comes from the provisioner, not the repo",
  conflict: "raced a concurrent change; the next sync converges",
  attachment: "an attachment file was not carried",
  "invalid-manifest": "the manifest could not be used",
  "invalid-skill": "SKILL.md does not conform to the Agent Skills spec",
  "unsupported-transport": "a transport this deployment never runs",
  "headers-dropped": "synced without its declared headers — credentials are set in the console",
  "duplicate-name": "more than one plugin claims this name",
  "credentials-reset": "its address moved, so stored credentials were dropped — re-enter them",
  "write-failed": "one write failed; the rest of the sync continued",
};

/** The skips that mean an operator has something to do, not just to know. */
const ATTENTION_REASONS = new Set<SyncSkip["reason"]>([
  "credentials-reset",
  "write-failed",
  "invalid-manifest",
  "invalid-skill",
  "duplicate-name",
]);

function toggle(list: string[], name: string): string[] {
  return list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name];
}

function SkipLine({ skip }: { skip: SyncSkip }) {
  return (
    <Text fz="xs" c={ATTENTION_REASONS.has(skip.reason) ? "orange" : undefined}>
      {skip.name} — {SKIP_REASONS[skip.reason]}
      {skip.detail ? `: ${skip.detail}` : ""}
    </Text>
  );
}

/**
 * The outcome of a plugins sync. The repository's content applied itself —
 * created and overwritten are records, not proposals — so what this shows is
 * what happened (by name, with the fields that moved; `source` among them is
 * an adoption) and the one decision left: deletion, with each orphan's
 * version bindings next to the checkbox, because a name a version still binds
 * does not stop being bound by being deleted.
 */
export function PluginSyncSummary({
  result,
  onApply,
}: {
  result: PluginSyncResult;
  /** Re-runs the sync with the chosen removals. */
  onApply: (selection: PluginSyncSelection) => Promise<void>;
}) {
  const t = useT();
  const [removeSkills, setRemoveSkills] = useState<string[]>([]);
  const [removeServers, setRemoveServers] = useState<string[]>([]);
  const [removePlugins, setRemovePlugins] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

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
    setApplyError(null);
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
    } catch (e) {
      // `void apply()` is fire-and-forget: without this the failure is an
      // unhandled rejection and the reader cannot tell whether anything was
      // deleted.
      setApplyError(reportError(e, "Delete failed"));
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
    if (
      report.created.length === 0 &&
      report.overwritten.length === 0 &&
      report.removed.length === 0 &&
      report.orphaned.length === 0 &&
      report.skipped.length === 0
    ) {
      return null;
    }
    return (
      <Stack gap={4}>
        {report.created.length > 0 && (
          <Text fz="xs">
            <Badge component="span" size="xs" color={BADGE.on} mr={6}>
              created
            </Badge>
            {report.created.join(", ")}
          </Text>
        )}
        {report.overwritten.map((entry: SyncWrite) => (
          <Text key={`ow-${entry.name}`} fz="xs">
            <Badge component="span" size="xs" color="blue" mr={6}>
              updated
            </Badge>
            {entry.name} — {entry.fields.join(", ")}
            {entry.fields.includes("source") ? " (adopted)" : ""}
          </Text>
        ))}
        {report.removed.length > 0 && (
          <Text fz="xs">
            <Badge component="span" size="xs" color={BADGE.broken} mr={6}>
              deleted
            </Badge>
            {report.removed.join(", ")}
          </Text>
        )}
        {report.orphaned.length > 0 && (
          <>
            <Text fz="xs" c="dimmed">
              These {label} came from this plugin and are no longer in it — ticked entries are
              deleted on Apply. A version still binding one keeps a dangling name.
            </Text>
            {report.orphaned.map((orphan: SyncOrphan) => (
              <Checkbox
                key={`rm-${orphan.name}`}
                size="xs"
                checked={picked.includes(orphan.name)}
                onChange={() => setPicked(toggle(picked, orphan.name))}
                label={
                  orphan.boundTo.length > 0
                    ? `${orphan.name} — bound by ${orphan.boundTo.slice(0, 5).join(", ")}${
                        orphan.boundTo.length > 5 ? ` +${orphan.boundTo.length - 5} more` : ""
                      }`
                    : orphan.name
                }
              />
            ))}
          </>
        )}
        {report.skipped.map((skip) => (
          <SkipLine key={`${skip.name}-${skip.reason}`} skip={skip} />
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
          <SkipLine key={`${skip.name}-${skip.reason}`} skip={skip} />
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
            <Divider label={t("nav.plugins")} labelPosition="left" />
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
            {applyError ? (
              <Text size="sm" c="red">
                {applyError}
              </Text>
            ) : null}
          </Group>
        )}
      </Stack>
    </Alert>
  );
}
