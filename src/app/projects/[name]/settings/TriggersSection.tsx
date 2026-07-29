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
import { formatDateTime } from "@/shared/date";
import {
  createTrigger,
  deleteTrigger,
  listTriggerRuns,
  listTriggers,
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
 * Webhook triggers: the delivery URL, the secret, and what recent deliveries
 * did. The secret is shown in the clear exactly once — on create and on
 * rotation — so the panel keeps it in state until the page is left.
 */
export function TriggersSection({ projectName }: { projectName: string }) {
  const [triggers, setTriggers] = useState<TriggerView[]>([]);
  const [runs, setRuns] = useState<Record<string, TriggerRun[]>>({});
  const [newId, setNewId] = useState("");
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

  const deliveryUrl = (triggerId: string) =>
    typeof window === "undefined"
      ? `/api/triggers/${projectName}/${triggerId}`
      : `${window.location.origin}/api/triggers/${projectName}/${triggerId}`;

  return (
    <CollapsibleSection title="Webhook triggers">
      <Stack gap="lg">
        <Text fz="sm" c="dimmed">
          An outside system can start a run by posting to a trigger&apos;s URL with its secret.
          Triggers always run the project&apos;s <strong>published</strong>{" "}
          version, and answer immediately — the delivery&apos;s outcome shows up in the table
          below rather than in the response.
        </Text>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Group align="flex-end" gap="sm">
          <TextInput
            label="New trigger id"
            placeholder="nightly-report"
            value={newId}
            onChange={(e) => setNewId(e.currentTarget.value)}
            disabled={loading}
          />
          <Button
            disabled={!newId.trim() || busy || loading}
            onClick={() =>
              act(async () => {
                const created = await createTrigger(projectName, { triggerId: newId.trim() });
                if (created.secret) {
                  setRevealed((prev) => ({ ...prev, [created.triggerId]: created.secret! }));
                }
                setNewId("");
              })
            }
          >
            Create
          </Button>
        </Group>

        {triggers.map((trigger) => (
          <Stack key={trigger.triggerId} gap="xs">
            <Group gap="sm">
              <Text fw={600}>{trigger.triggerId}</Text>
              <Badge color={trigger.enabled ? "teal" : "gray"} variant="light">
                {trigger.enabled ? "enabled" : "disabled"}
              </Badge>
            </Group>
            <CopyableUrl url={deliveryUrl(trigger.triggerId)} />
            {revealed[trigger.triggerId] ? (
              <Stack gap={4}>
                <Text fz="sm" c="orange">
                  Copy this secret now — it is not shown again.
                </Text>
                <Code block>{revealed[trigger.triggerId]}</Code>
              </Stack>
            ) : (
              <Text fz="sm" c="dimmed">
                Secret: <code>{trigger.secretMasked}</code> — send it as{" "}
                <code>X-Trigger-Secret</code>.
              </Text>
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
            </Group>
            <Group gap="sm">
              <Button
                variant="default"
                size="xs"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const rotated = await updateTrigger(projectName, trigger.triggerId, {
                      rotateSecret: true,
                    });
                    if (rotated.secret) {
                      setRevealed((prev) => ({ ...prev, [trigger.triggerId]: rotated.secret! }));
                    }
                  })
                }
              >
                Rotate secret
              </Button>
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
