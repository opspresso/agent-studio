"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Code,
  Button,
  Group,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { CopyButton } from "@/app/_components/CopyButton";
import { toSlug } from "@/shared/slug";
import { formatDateTime } from "@/shared/date";
import {
  createTrigger,
  deleteTrigger,
  listTriggerRuns,
  listTriggers,
  revealTriggerSecret,
  updateTrigger,
  type TriggerRun,
  type TriggerView,
} from "../../lib/api";

const STATUS_COLOR: Record<TriggerRun["status"], string> = {
  running: "blue",
  succeeded: "teal",
  failed: "red",
  skipped: "gray",
};

/**
 * Triggers: webhooks (a delivery URL and its secret) and schedules (a cron in
 * a timezone), plus what recent firings did. A webhook secret is shown in the
 * clear exactly once — on create and on rotation — so the panel keeps it in
 * state until the page is left.
 */
export function TriggersSection({ projectName }: { projectName: string }) {
  const [triggers, setTriggers] = useState<TriggerView[]>([]);
  const [runs, setRuns] = useState<Record<string, TriggerRun[]>>({});
  const [newId, setNewId] = useState("");
  const [newKind, setNewKind] = useState<"webhook" | "schedule">("webhook");
  const [newCron, setNewCron] = useState("");
  const [newTimezone, setNewTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [newMessage, setNewMessage] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { triggers: loaded } = await listTriggers(projectName);
    setTriggers(loaded);
    const entries = await Promise.all(
      loaded.map(async (trigger) => {
        const { runs: recent } = await listTriggerRuns(projectName, trigger.triggerId);
        return [trigger.triggerId, recent] as const;
      }),
    );
    setRuns(Object.fromEntries(entries));
  }, [projectName]);

  useEffect(() => {
    let cancelled = false;
    void reload()
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load triggers");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  /** Drop a revealed secret back to its mask without reloading the panel. */
  function hide(triggerId: string) {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[triggerId];
      return next;
    });
  }

  const deliveryUrl = (triggerId: string) =>
    typeof window === "undefined"
      ? `/api/triggers/${projectName}/${triggerId}`
      : `${window.location.origin}/api/triggers/${projectName}/${triggerId}`;

  const createDisabled =
    !toSlug(newId) ||
    busy ||
    loading ||
    (newKind === "schedule" && (!newCron.trim() || !newTimezone.trim()));

  return (
    <CollapsibleSection title="Triggers">
      <Stack gap="lg">
        <Text fz="sm" c="dimmed">
          An outside system can start a run by posting to a webhook trigger&apos;s URL with its
          secret; a schedule trigger fires on its own cron. Triggers always run the project&apos;s{" "}
          <strong>published</strong> version, and their outcomes show up in the table below.
        </Text>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Stack gap="sm">
          <Group align="flex-end" gap="sm">
            <TextInput
              label="New trigger id"
              placeholder="nightly-report"
              value={newId}
              onChange={(e) => setNewId(e.currentTarget.value)}
              // Same rule and same moment as a project name: normalised on blur so
              // typing stays unsurprising, and the id that reaches the slug-only
              // API is always one it accepts.
              onBlur={() => setNewId(toSlug(newId))}
              description="Lowercase letters, digits, and hyphens only."
              // Description above the input, so in this `flex-end` row the input
              // box itself is the wrapper's bottom edge and lines up with the
              // description-less fields and buttons beside it.
              inputWrapperOrder={["label", "description", "input", "error"]}
              disabled={loading}
            />
            <Select
              label="Kind"
              data={[
                { value: "webhook", label: "Webhook" },
                { value: "schedule", label: "Schedule" },
              ]}
              w={140}
              value={newKind}
              onChange={(value) => value && setNewKind(value as "webhook" | "schedule")}
              disabled={loading}
            />
            <Button
              disabled={createDisabled}
              onClick={() =>
                act(async () => {
                  const created = await createTrigger(projectName, {
                    triggerId: toSlug(newId),
                    ...(newKind === "schedule"
                      ? {
                          kind: "schedule" as const,
                          cron: newCron.trim(),
                          timezone: newTimezone.trim(),
                          ...(newMessage.trim() ? { message: newMessage } : {}),
                        }
                      : {}),
                  });
                  if (created.secret) {
                    setRevealed((prev) => ({ ...prev, [created.triggerId]: created.secret! }));
                  }
                  setNewId("");
                  setNewCron("");
                  setNewMessage("");
                })
              }
            >
              Create
            </Button>
          </Group>
          {newKind === "schedule" && (
            <Group align="flex-end" gap="sm">
              <TextInput
                label="Cron"
                placeholder="30 9 * * 1-5"
                description="minute hour day-of-month month day-of-week"
                inputWrapperOrder={["label", "description", "input", "error"]}
                value={newCron}
                onChange={(e) => setNewCron(e.currentTarget.value)}
                w={180}
              />
              <TextInput
                label="Timezone"
                placeholder="Asia/Seoul"
                value={newTimezone}
                onChange={(e) => setNewTimezone(e.currentTarget.value)}
                w={180}
              />
              <TextInput
                label="Message"
                placeholder="What each firing asks the project"
                value={newMessage}
                onChange={(e) => setNewMessage(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
            </Group>
          )}
        </Stack>

        {triggers.map((trigger) => (
          <Stack key={trigger.triggerId} gap="xs">
            <Group gap="sm">
              <Text fw={600}>{trigger.triggerId}</Text>
              <Badge variant="outline" color="gray">
                {trigger.kind}
              </Badge>
              <Badge color={trigger.enabled ? "teal" : "gray"} variant="light">
                {trigger.enabled ? "enabled" : "disabled"}
              </Badge>
            </Group>
            {trigger.kind === "webhook" && (
              <>
                <CopyableUrl url={deliveryUrl(trigger.triggerId)} />
                {revealed[trigger.triggerId] ? (
                  <Alert color="yellow" variant="light" p="sm">
                    <Group gap="xs" wrap="nowrap">
                      <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                        {revealed[trigger.triggerId]}
                      </Code>
                      <CopyButton text={revealed[trigger.triggerId]!} />
                      <Button
                        variant="default"
                        size="compact-xs"
                        onClick={() => hide(trigger.triggerId)}
                      >
                        Hide
                      </Button>
                    </Group>
                    <Text fz="xs" mt={4}>
                      Send it as <Code>X-Trigger-Secret</Code>. Anyone holding it can start this
                      project&apos;s published version.
                    </Text>
                  </Alert>
                ) : (
                  <Group gap="xs" wrap="nowrap">
                    <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                      {trigger.secretMasked}
                    </Code>
                    <Button
                      variant="default"
                      size="compact-xs"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          const secret = await revealTriggerSecret(projectName, trigger.triggerId);
                          setRevealed((prev) => ({ ...prev, [trigger.triggerId]: secret }));
                        })
                      }
                    >
                      Reveal
                    </Button>
                  </Group>
                )}
              </>
            )}
            {trigger.kind === "schedule" && (
              <ScheduleFields
                trigger={trigger}
                busy={busy}
                onSave={(input) =>
                  act(async () => {
                    await updateTrigger(projectName, trigger.triggerId, input);
                  })
                }
              />
            )}
            <Group gap="md" align="center">
              <Switch
                label="Enabled"
                checked={trigger.enabled}
                disabled={busy}
                onChange={(e) =>
                  act(async () => {
                    await updateTrigger(projectName, trigger.triggerId, {
                      enabled: e.currentTarget.checked,
                    });
                  })
                }
              />
              <Switch
                label="Allow overlapping runs"
                checked={trigger.allowConcurrent}
                disabled={busy}
                onChange={(e) =>
                  act(async () => {
                    await updateTrigger(projectName, trigger.triggerId, {
                      allowConcurrent: e.currentTarget.checked,
                    });
                  })
                }
              />
              {trigger.kind === "webhook" && (
                <Select
                  label="Payload"
                  data={[
                    { value: "message", label: "User message (agent)" },
                    { value: "variables", label: "Template variables (prompt)" },
                  ]}
                  w={220}
                  value={trigger.payloadMode}
                  disabled={busy}
                  onChange={(value) =>
                    value &&
                    act(async () => {
                      await updateTrigger(projectName, trigger.triggerId, {
                        payloadMode: value as "variables" | "message",
                      });
                    })
                  }
                />
              )}
            </Group>
            <Group gap="sm">
              {trigger.kind === "webhook" && (
                <Button
                  variant="default"
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !confirm(
                        `Regenerate the secret for "${trigger.triggerId}"? The current secret stops working immediately.`,
                      )
                    ) {
                      return;
                    }
                    void act(async () => {
                      const rotated = await updateTrigger(projectName, trigger.triggerId, {
                        rotateSecret: true,
                      });
                      if (rotated.secret) {
                        setRevealed((prev) => ({ ...prev, [trigger.triggerId]: rotated.secret! }));
                      }
                    });
                  }}
                >
                  Regenerate secret
                </Button>
              )}
              <Button
                variant="default"
                color="red"
                size="xs"
                disabled={busy}
                onClick={() => {
                  if (!confirm(`Delete trigger "${trigger.triggerId}"?`)) {
                    return;
                  }
                  void act(() => deleteTrigger(projectName, trigger.triggerId));
                }}
              >
                Delete
              </Button>
            </Group>

            {(runs[trigger.triggerId]?.length ?? 0) > 0 && (
              <Table fz="xs" withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    {/* Widths are reserved rather than left to the content: a
                        Mantine Badge clips its own label to the cell, so an
                        unsized Status column renders "SUCCEED…" — the one thing
                        this table exists to show. */}
                    <Table.Th w={170}>Started</Table.Th>
                    <Table.Th w={130}>Status</Table.Th>
                    <Table.Th>Result</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {runs[trigger.triggerId]?.map((run) => (
                    <Table.Tr key={run.runId}>
                      {/* The raw ISO string wrapped onto two lines and squeezed
                          the status badge into "SUCCEE…" — a status column you
                          cannot read defeats the table. */}
                      <Table.Td style={{ whiteSpace: "nowrap" }}>
                        {formatDateTime(run.startedAt)}
                      </Table.Td>
                      <Table.Td style={{ whiteSpace: "nowrap" }}>
                        {/* Badge clamps its own label independently of the cell,
                            so the column width alone still rendered "SUCCEED…". */}
                        <Badge
                          color={STATUS_COLOR[run.status]}
                          variant="light"
                          styles={{ label: { overflow: "visible" } }}
                        >
                          {run.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{run.error ?? run.result ?? ""}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        ))}

        {!loading && triggers.length === 0 && (
          <Text fz="sm" c="dimmed">
            No triggers yet.
          </Text>
        )}
      </Stack>
    </CollapsibleSection>
  );
}

/**
 * A schedule's own fields, drafted locally and saved as one update.
 *
 * Not keyed by `updatedAt`: the Enabled and overlap switches beside this also
 * update-and-reload, and a remount would silently discard a cron edit in
 * progress. Instead the draft re-syncs to the server values only when they
 * change while the draft is clean — a dirty draft survives unrelated toggles,
 * and Save is what resolves a conflict with an edit that landed elsewhere.
 */
function ScheduleFields({
  trigger,
  busy,
  onSave,
}: {
  trigger: TriggerView;
  busy: boolean;
  onSave: (input: { cron: string; timezone: string; message: string }) => void;
}) {
  const server = {
    cron: trigger.cron ?? "",
    timezone: trigger.timezone ?? "",
    message: trigger.message ?? "",
  };
  const [draft, setDraft] = useState(server);
  const [seen, setSeen] = useState(server);
  const same = (a: typeof server, b: typeof server) =>
    a.cron === b.cron && a.timezone === b.timezone && a.message === b.message;
  if (!same(server, seen)) {
    // Render-time state adjustment, the React-sanctioned key-less reset.
    setSeen(server);
    if (same(draft, seen)) {
      setDraft(server);
    }
  }
  const { cron, timezone, message } = draft;
  const setCron = (value: string) => setDraft((d) => ({ ...d, cron: value }));
  const setTimezone = (value: string) => setDraft((d) => ({ ...d, timezone: value }));
  const setMessage = (value: string) => setDraft((d) => ({ ...d, message: value }));
  const dirty = !same(draft, server);
  return (
    <Group align="flex-end" gap="sm">
      <TextInput
        label="Cron"
        description="minute hour day-of-month month day-of-week"
        inputWrapperOrder={["label", "description", "input", "error"]}
        value={cron}
        onChange={(e) => setCron(e.currentTarget.value)}
        w={180}
      />
      <TextInput
        label="Timezone"
        value={timezone}
        onChange={(e) => setTimezone(e.currentTarget.value)}
        w={180}
      />
      <TextInput
        label="Message"
        placeholder="What each firing asks the project"
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
        style={{ flex: 1 }}
      />
      <Button
        variant="default"
        disabled={busy || !dirty || !cron.trim() || !timezone.trim()}
        onClick={() => onSave({ cron: cron.trim(), timezone: timezone.trim(), message })}
      >
        Save
      </Button>
    </Group>
  );
}
