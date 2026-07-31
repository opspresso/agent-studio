"use client";

import { useState } from "react";
import { Alert, Button, Checkbox, Group, Stack, Text } from "@mantine/core";
import type { RepoSyncResult, SyncSelection, SyncSkip } from "@/domain/sync/types";

/** What a skip means, in words an operator can act on. */
const SKIP_REASONS: Record<SyncSkip["reason"], string> = {
  "bad-name": "name is not a slug (lowercase letters, digits, hyphens)",
  "missing-url": "no url in the frontmatter, and no stored entry to keep one",
  "invalid-url": "url refused",
  "managed-url": "managed entry — its address comes from the provisioner, not the repo",
  conflict: "registered by someone else mid-sync; the next sync picks it up",
  attachment: "an attachment file was not carried",
};

/**
 * The outcome of a sync, and the two decisions it deliberately did not make.
 *
 * A sync imports what is missing and reports the rest, so this is where an
 * operator chooses: which entries the repository's version should replace, and
 * which entries the repository no longer carries should be deleted. Both are
 * unticked by default — an entry may hold credentials or an edit someone made on
 * purpose, and neither is something a pull of a branch should decide.
 *
 * Shared by the skills and tools pages, so the two reports read the same and
 * cannot drift into describing the same situation differently.
 */
export function SyncSummary({
  result,
  onApply,
  label,
}: {
  result: RepoSyncResult;
  /** Re-runs the sync with the chosen names. */
  onApply: (selection: SyncSelection) => Promise<void>;
  /** What one entry is called here — "skill", "tool". */
  label: string;
}) {
  const [overwrite, setOverwrite] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  const changed = result.existing.filter((entry) => entry.differs.length > 0);
  const chose = overwrite.length > 0 || remove.length > 0;
  const attention = result.skipped.length > 0 || changed.length > 0 || result.orphaned.length > 0;

  async function apply() {
    setApplying(true);
    try {
      await onApply({
        ...(overwrite.length > 0 ? { overwrite } : {}),
        ...(remove.length > 0 ? { remove } : {}),
      });
      setOverwrite([]);
      setRemove([]);
    } finally {
      setApplying(false);
    }
  }

  return (
    <Alert color={attention ? "yellow" : "teal"} variant="light">
      <Stack gap="xs">
        <Text fz="sm">
          Imported {result.created.length}
          {result.overwritten.length > 0 ? ` · overwritten ${result.overwritten.length}` : ""}
          {result.removed.length > 0 ? ` · deleted ${result.removed.length}` : ""}
          {` · already registered ${result.existing.length}`}
          {result.skipped.length > 0 ? ` · skipped ${result.skipped.length}` : ""}
        </Text>

        {changed.length > 0 && (
          <Checkbox.Group
            value={overwrite}
            onChange={setOverwrite}
            label={`These ${label}s differ from the repository`}
            description="Ticked entries are replaced with the repository's version. Nothing else about them changes."
          >
            <Stack gap={2} mt={4}>
              {changed.map((entry) => (
                <Checkbox
                  key={entry.name}
                  value={entry.name}
                  size="xs"
                  label={`${entry.name} — ${entry.differs.join(", ")}`}
                />
              ))}
            </Stack>
          </Checkbox.Group>
        )}

        {result.orphaned.length > 0 && (
          <Checkbox.Group
            value={remove}
            onChange={setRemove}
            label={`These ${label}s came from the repository and are no longer in it`}
            description="Ticked entries are deleted. Anything registered by hand is never listed here."
          >
            <Stack gap={2} mt={4}>
              {result.orphaned.map((name) => (
                <Checkbox key={name} value={name} size="xs" label={name} />
              ))}
            </Stack>
          </Checkbox.Group>
        )}

        {result.skipped.map((skip) => (
          <Text key={`${skip.name}-${skip.reason}`} fz="xs">
            {skip.name} — {SKIP_REASONS[skip.reason]}
            {skip.detail ? `: ${skip.detail}` : ""}
          </Text>
        ))}

        {(changed.length > 0 || result.orphaned.length > 0) && (
          <Group>
            <Button size="xs" disabled={!chose} loading={applying} onClick={() => void apply()}>
              Apply {overwrite.length + remove.length} change
              {overwrite.length + remove.length === 1 ? "" : "s"}
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}
