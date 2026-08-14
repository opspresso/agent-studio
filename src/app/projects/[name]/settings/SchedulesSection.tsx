"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/app/_components/useConfirm";
import { Alert, Badge, Button, Group, Stack, Switch, Text, TextInput } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { stateColor } from "@/app/_components/badgeColors";
import { toSlug } from "@/shared/slug";
import { useT } from "@/app/_i18n/provider";
import { TriggerRuns } from "./TriggerRuns";
import {
  createTrigger,
  deleteTrigger,
  listTriggerRuns,
  listTriggers,
  updateTrigger,
  type TriggerRun,
  type TriggerView,
} from "../../lib/api";

/**
 * Schedules: a cron in a timezone, and what recent firings did.
 *
 * The other way something outside the console starts a run — the project's
 * webhook — is one section up and is not a row anyone names, so this list is
 * schedules and only schedules.
 */
export function SchedulesSection({ projectName }: { projectName: string }) {
  const t = useT();
  const [schedules, setSchedules] = useState<TriggerView[]>([]);
  const [runs, setRuns] = useState<Record<string, TriggerRun[]>>({});
  const [newId, setNewId] = useState("");
  const [newCron, setNewCron] = useState("");
  const [newTimezone, setNewTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [newMessage, setNewMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { triggers } = await listTriggers(projectName);
    const listed = triggers.filter((trigger) => trigger.kind === "schedule");
    setSchedules(listed);
    const entries = await Promise.all(
      listed.map(async (trigger) => {
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
          setError(e instanceof Error ? e.message : "Failed to load schedules");
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

  const createDisabled =
    !toSlug(newId) || busy || loading || !newCron.trim() || !newTimezone.trim();

  const { confirm, confirmModal } = useConfirm();

  return (
    <CollapsibleSection
      title={t("schedule.section")}
      // Readable while collapsed, like the token's set/none: how many schedules
      // exist, before anyone opens the section.
      badge={
        loading ? undefined : (
          <Badge color={stateColor(schedules.length > 0)} radius="xl">
            {schedules.length > 0 ? schedules.length : "none"}
          </Badge>
        )
      }
    >
      <Stack gap="lg">
        {confirmModal}
        <Text fz="sm" c="dimmed">
          {t("schedule.intro")}
        </Text>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Stack gap="sm">
          <Group align="flex-end" gap="sm">
            <TextInput
              label={t("trigger.newId")}
              placeholder={t("trigger.newIdPlaceholder")}
              value={newId}
              onChange={(e) => setNewId(e.currentTarget.value)}
              // Same rule and same moment as a project name: normalised on blur so
              // typing stays unsurprising, and the id that reaches the slug-only
              // API is always one it accepts.
              onBlur={() => setNewId(toSlug(newId))}
              description={t("registry.nameHint")}
              // Description above the input, so in this `flex-end` row the input
              // box itself is the wrapper's bottom edge and lines up with the
              // description-less fields and buttons beside it.
              inputWrapperOrder={["label", "description", "input", "error"]}
              disabled={loading}
            />
            <TextInput
              label={t("trigger.cron")}
              placeholder={t("trigger.cronPlaceholder")}
              description={t("trigger.cronHint")}
              inputWrapperOrder={["label", "description", "input", "error"]}
              value={newCron}
              onChange={(e) => setNewCron(e.currentTarget.value)}
              w={180}
            />
            <TextInput
              label={t("trigger.timezone")}
              placeholder={t("trigger.timezonePlaceholder")}
              value={newTimezone}
              onChange={(e) => setNewTimezone(e.currentTarget.value)}
              w={180}
            />
            <Button
              disabled={createDisabled}
              onClick={() =>
                act(async () => {
                  await createTrigger(projectName, {
                    triggerId: toSlug(newId),
                    kind: "schedule",
                    cron: newCron.trim(),
                    timezone: newTimezone.trim(),
                    ...(newMessage.trim() ? { message: newMessage } : {}),
                  });
                  setNewId("");
                  setNewCron("");
                  setNewMessage("");
                })
              }
            >
              Create
            </Button>
          </Group>
          <TextInput
            label={t("trigger.message")}
            placeholder={t("trigger.messagePlaceholder")}
            value={newMessage}
            onChange={(e) => setNewMessage(e.currentTarget.value)}
          />
        </Stack>

        {schedules.map((schedule) => (
          <Stack key={schedule.triggerId} gap="xs">
            <Group gap="sm">
              <Text fw={600}>{schedule.triggerId}</Text>
              <Badge color={schedule.enabled ? "teal" : "gray"} variant="light">
                {schedule.enabled ? "enabled" : "disabled"}
              </Badge>
            </Group>
            <ScheduleFields
              schedule={schedule}
              busy={busy}
              onSave={(input) =>
                act(async () => {
                  await updateTrigger(projectName, schedule.triggerId, input);
                })
              }
            />
            <Group gap="md" align="center">
              <Switch
                label={t("trigger.enabled")}
                checked={schedule.enabled}
                disabled={busy}
                onChange={(e) =>
                  act(async () => {
                    await updateTrigger(projectName, schedule.triggerId, {
                      enabled: e.currentTarget.checked,
                    });
                  })
                }
              />
              <Switch
                label={t("trigger.allowOverlap")}
                checked={schedule.allowConcurrent}
                disabled={busy}
                onChange={(e) =>
                  act(async () => {
                    await updateTrigger(projectName, schedule.triggerId, {
                      allowConcurrent: e.currentTarget.checked,
                    });
                  })
                }
              />
              <Button
                variant="default"
                color="red"
                size="xs"
                disabled={busy}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Delete schedule",
                      message: `Delete schedule "${schedule.triggerId}"?`,
                      confirmLabel: "Delete",
                    }))
                  ) {
                    return;
                  }
                  void act(() => deleteTrigger(projectName, schedule.triggerId));
                }}
              >
                Delete
              </Button>
            </Group>

            <TriggerRuns runs={runs[schedule.triggerId] ?? []} />
          </Stack>
        ))}

        {!loading && schedules.length === 0 && (
          <Text fz="sm" c="dimmed">
            No schedules yet.
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
  schedule,
  busy,
  onSave,
}: {
  schedule: TriggerView;
  busy: boolean;
  onSave: (input: { cron: string; timezone: string; message: string }) => void;
}) {
  const t = useT();
  const server = {
    cron: schedule.cron ?? "",
    timezone: schedule.timezone ?? "",
    message: schedule.message ?? "",
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
        label={t("trigger.cron")}
        description={t("trigger.cronHint")}
        inputWrapperOrder={["label", "description", "input", "error"]}
        value={cron}
        onChange={(e) => setCron(e.currentTarget.value)}
        w={180}
      />
      <TextInput
        label={t("trigger.timezone")}
        value={timezone}
        onChange={(e) => setTimezone(e.currentTarget.value)}
        w={180}
      />
      <TextInput
        label={t("trigger.message")}
        placeholder={t("trigger.messagePlaceholder")}
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
