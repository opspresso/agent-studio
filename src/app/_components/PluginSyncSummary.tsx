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
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useT } from "@/app/_i18n/provider";

/** What a skip means, in words an operator can act on. */
const SKIP_REASONS: Record<SyncSkip["reason"], MessageKey> = {
  "bad-name": "sync.skip.bad-name",
  "invalid-url": "sync.skip.invalid-url",
  "managed-url": "sync.skip.managed-url",
  conflict: "sync.skip.conflict",
  attachment: "sync.skip.attachment",
  "invalid-manifest": "sync.skip.invalid-manifest",
  "invalid-skill": "sync.skip.invalid-skill",
  "unsupported-transport": "sync.skip.unsupported-transport",
  "headers-dropped": "sync.skip.headers-dropped",
  "duplicate-name": "sync.skip.duplicate-name",
  "credentials-reset": "sync.skip.credentials-reset",
  "write-failed": "sync.skip.write-failed",
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
  const t = useT();
  return (
    <Text fz="xs" c={ATTENTION_REASONS.has(skip.reason) ? "orange" : undefined}>
      {skip.name} — {t(SKIP_REASONS[skip.reason])}
      {skip.detail ? `: ${skip.detail}` : ""}
    </Text>
  );
}

/**
 * The outcome of a plugins sync. The repository's content applied itself —
 * created and overwritten are records, not proposals — so what this shows is
 * what happened (by name, with the fields that moved; `source` among them is
 * an adoption) and the one decision left: deletion, with each orphan's
 * Agent bindings next to the checkbox, because a name an Agent still binds
 * does not stop being bound by being deleted.
 */
export function PluginSyncSummary({
  result,
  onApply,
  busy,
}: {
  result: PluginSyncResult;
  /** Re-runs the sync with the chosen removals. */
  onApply: (selection: PluginSyncSelection) => Promise<void>;
  /** Shared with source sync/upload so an older operation cannot replace a newer report. */
  busy: boolean;
}) {
  const t = useT();
  const [removeSkills, setRemoveSkills] = useState<string[]>([]);
  const [removeServers, setRemoveServers] = useState<string[]>([]);
  const [removePlugins, setRemovePlugins] = useState<string[]>([]);
  const [applyError, setApplyError] = useState<string | null>(null);

  const totals = { created: 0, overwritten: 0, unchanged: 0, removed: result.removedPlugins.length, skipped: result.skipped.length };
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
    if (busy) return;
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
              {t("sync.created")}
            </Badge>
            {report.created.join(", ")}
          </Text>
        )}
        {report.overwritten.map((entry: SyncWrite) => (
          <Text key={`ow-${entry.name}`} fz="xs">
            <Badge component="span" size="xs" color={BADGE.owned} mr={6}>
              {t("sync.updated")}
            </Badge>
            {entry.name} — {entry.fields.join(", ")}
            {entry.fields.includes("source") ? ` (${t("sync.adopted")})` : ""}
          </Text>
        ))}
        {report.removed.length > 0 && (
          <Text fz="xs">
            <Badge component="span" size="xs" color={BADGE.broken} mr={6}>
              {t("sync.deleted")}
            </Badge>
            {report.removed.join(", ")}
          </Text>
        )}
        {report.orphaned.length > 0 && (
          <>
            <Text fz="xs" c="dimmed">
              {t("sync.orphanedEntries", { kind: label })}
            </Text>
            {report.orphaned.map((orphan: SyncOrphan) => (
              <Checkbox
                key={`rm-${orphan.name}`}
                size="xs"
                checked={picked.includes(orphan.name)}
                disabled={busy}
                onChange={() => setPicked(toggle(picked, orphan.name))}
                label={
                  orphan.boundTo === null
                    ? `${orphan.name} — ${t("plugins.bindingsUnavailable")}`
                    : orphan.boundTo.length > 0
                    ? `${orphan.name} — ${t("sync.boundBy", { agents: orphan.boundTo.slice(0, 5).join(", ") })}${
                        orphan.boundTo.length > 5 ? ` ${t("sync.more", { count: orphan.boundTo.length - 5 })}` : ""
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
          {t("sync.importedCount", { count: totals.created })}
          {totals.overwritten > 0 ? ` · ${t("sync.updatedCount", { count: totals.overwritten })}` : ""}
          {totals.removed > 0 ? ` · ${t("sync.deletedCount", { count: totals.removed })}` : ""}
          {` · ${t("sync.unchangedCount", { count: totals.unchanged })}`}
          {totals.skipped > 0 ? ` · ${t("sync.skippedCount", { count: totals.skipped })}` : ""}
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
              {t("sync.orphanedPlugins")}
            </Text>
            {result.orphanedPlugins.map((name) => (
              <Checkbox
                key={`plugin-${name}`}
                size="xs"
                checked={removePlugins.includes(name)}
                disabled={busy}
                onChange={() => setRemovePlugins(toggle(removePlugins, name))}
                label={name}
              />
            ))}
          </Stack>
        )}

        {chosen > 0 && (
          <Group>
            <Button size="xs" color={BADGE.broken} loading={busy} onClick={() => void apply()}>
              {t(chosen === 1 ? "sync.deleteOne" : "sync.deleteMany", { count: chosen })}
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
