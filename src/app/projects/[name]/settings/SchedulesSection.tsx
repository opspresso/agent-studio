"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useConfirm } from "@/app/_components/useConfirm";
import { Alert, Badge, Button, Group, Paper, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { stateColor } from "@/app/_components/badgeColors";
import { PROJECT_WEBHOOK_ID } from "@/domain/trigger/types";
import type { ScheduleDelivery, ScheduleDeliveryKind } from "@/domain/trigger/types";
import { toSlug } from "@/shared/slug";
import { useT } from "@/app/_i18n/provider";
import { TriggerRuns } from "./TriggerRuns";
import {
  createTrigger,
  deleteTrigger,
  getProjectTeams,
  getProjectTelegram,
  listTriggerRuns,
  listProjectSlackChannels,
  listTriggers,
  updateTrigger,
  type TriggerRun,
  type TriggerView,
  type SlackChannelInfo,
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
  const [slackChannels, setSlackChannels] = useState<SlackChannelInfo[]>([]);
  const [slackChannelsUnavailable, setSlackChannelsUnavailable] = useState(false);
  const [availableDestinations, setAvailableDestinations] = useState<ScheduleDeliveryKind[]>([]);
  // Webhook rows registered by name before a project had one of its own. There
  // is no delivery address that reaches them any more, so they run nothing —
  // but the row is still an encrypted secret, and a credential nobody can see
  // is a credential nobody can revoke. Listed only to be deleted.
  const [orphans, setOrphans] = useState<TriggerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { triggers } = await listTriggers(projectName);
    const listed = triggers.filter((trigger) => trigger.kind === "schedule");
    setSchedules(listed);
    setOrphans(
      triggers.filter(
        (trigger) => trigger.kind !== "schedule" && trigger.triggerId !== PROJECT_WEBHOOK_ID,
      ),
    );
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

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      listProjectSlackChannels(projectName),
      getProjectTelegram(projectName),
      getProjectTeams(projectName),
    ]).then(([slack, telegram, teams]) => {
      if (cancelled) {
        return;
      }
      const channels = slack.status === "fulfilled" ? slack.value.channels : [];
      setSlackChannels(channels);
      setSlackChannelsUnavailable(slack.status === "rejected" || channels.length === 0);
      setAvailableDestinations([
        ...(channels.length > 0 ? (["slack"] as const) : []),
        ...(telegram.status === "fulfilled" && telegram.value.configured && telegram.value.enabled
          ? (["telegram"] as const)
          : []),
        ...(teams.status === "fulfilled" && teams.value.configured && teams.value.enabled
          ? (["teams"] as const)
          : []),
      ]);
    });
    return () => {
      cancelled = true;
    };
  }, [projectName]);

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
          <Paper key={schedule.triggerId} withBorder radius="md" p="md">
            <Stack gap="sm">
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
              <ScheduleDestinations
                schedule={schedule}
                slackChannels={slackChannels}
                slackChannelsUnavailable={slackChannelsUnavailable}
                availableDestinations={availableDestinations}
                busy={busy}
                onSave={(deliveries) =>
                  act(async () => {
                    await updateTrigger(projectName, schedule.triggerId, { deliveries });
                  })
                }
                actions={
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
                }
              />

              <TriggerRuns runs={runs[schedule.triggerId] ?? []} />
            </Stack>
          </Paper>
        ))}

        {!loading && schedules.length === 0 && (
          <Text fz="sm" c="dimmed">
            No schedules yet.
          </Text>
        )}

        {orphans.length > 0 && (
          <Alert color="yellow" variant="light">
            <Stack gap="xs">
              <Text fz="sm">
                {orphans.length === 1 ? "A webhook" : "Webhooks"} registered under{" "}
                {orphans.length === 1 ? "a name" : "names"} of their own, from before a project had
                one webhook addressed by its own name. Nothing delivers to{" "}
                {orphans.length === 1 ? "it" : "them"} any more; deleting{" "}
                {orphans.length === 1 ? "it retires its secret" : "them retires their secrets"}.
              </Text>
              {orphans.map((orphan) => (
                <Group key={orphan.triggerId} gap="sm">
                  <Text fw={600} fz="sm">
                    {orphan.triggerId}
                  </Text>
                  <Button
                    variant="default"
                    color="red"
                    size="compact-xs"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !(await confirm({
                          title: "Delete webhook",
                          message: `Delete the retired webhook "${orphan.triggerId}"? Its secret stops existing.`,
                          confirmLabel: "Delete",
                        }))
                      ) {
                        return;
                      }
                      void act(() => deleteTrigger(projectName, orphan.triggerId));
                    }}
                  >
                    Delete
                  </Button>
                </Group>
              ))}
            </Stack>
          </Alert>
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
        {t("trigger.saveScheduleSettings")}
      </Button>
    </Group>
  );
}

interface DestinationDraft {
  kinds: ScheduleDeliveryKind[];
  slackChannelId: string;
  telegramChatId: string;
  telegramThreadId: string;
  teamsConversationId: string;
}

function destinationDraft(deliveries: readonly ScheduleDelivery[] = []): DestinationDraft {
  const slack = deliveries.find((delivery) => delivery.kind === "slack");
  const telegram = deliveries.find((delivery) => delivery.kind === "telegram");
  const teams = deliveries.find((delivery) => delivery.kind === "teams");
  return {
    kinds: deliveries.map((delivery) => delivery.kind),
    slackChannelId: slack?.kind === "slack" ? slack.channelId : "",
    telegramChatId: telegram?.kind === "telegram" ? String(telegram.chatId) : "",
    telegramThreadId:
      telegram?.kind === "telegram" && telegram.threadId !== undefined
        ? String(telegram.threadId)
        : "",
    teamsConversationId: teams?.kind === "teams" ? teams.conversationId : "",
  };
}

function sameDestinations(a: DestinationDraft, b: DestinationDraft): boolean {
  return (
    a.kinds.join(",") === b.kinds.join(",") &&
    a.slackChannelId === b.slackChannelId &&
    a.telegramChatId === b.telegramChatId &&
    a.telegramThreadId === b.telegramThreadId &&
    a.teamsConversationId === b.teamsConversationId
  );
}

function ScheduleDestinations({
  schedule,
  slackChannels,
  slackChannelsUnavailable,
  availableDestinations,
  busy,
  onSave,
  actions,
}: {
  schedule: TriggerView;
  slackChannels: SlackChannelInfo[];
  slackChannelsUnavailable: boolean;
  availableDestinations: ScheduleDeliveryKind[];
  busy: boolean;
  onSave: (deliveries: ScheduleDelivery[]) => void;
  actions: ReactNode;
}) {
  const t = useT();
  const server = destinationDraft(schedule.deliveries);
  const [draft, setDraft] = useState(server);
  const [seen, setSeen] = useState(server);
  const [kindToAdd, setKindToAdd] = useState<ScheduleDeliveryKind | null>(null);
  if (!sameDestinations(server, seen)) {
    setSeen(server);
    if (sameDestinations(draft, seen)) {
      setDraft(server);
    }
  }
  const telegramChatId = draft.telegramChatId.trim();
  const telegramThreadId = draft.telegramThreadId.trim();
  const chatId = Number(telegramChatId);
  const threadId = Number(telegramThreadId);
  const telegramValid =
    (!draft.kinds.includes("telegram") ||
      (Boolean(telegramChatId) && Number.isSafeInteger(chatId))) &&
    (!telegramThreadId || (Number.isSafeInteger(threadId) && threadId > 0)) &&
    (!telegramThreadId || Boolean(telegramChatId));
  const destinationsValid =
    telegramValid &&
    (!draft.kinds.includes("slack") || Boolean(draft.slackChannelId)) &&
    (!draft.kinds.includes("teams") || Boolean(draft.teamsConversationId.trim()));
  const dirty = !sameDestinations(draft, server);
  const channelData = slackChannels.map((channel) => ({
    value: channel.id,
    label: `#${channel.name}${channel.isPrivate ? " (private)" : ""}`,
  }));
  if (
    draft.slackChannelId &&
    !channelData.some((channel) => channel.value === draft.slackChannelId)
  ) {
    channelData.unshift({ value: draft.slackChannelId, label: draft.slackChannelId });
  }
  const destinationKinds = availableDestinations
    .filter((kind) => !draft.kinds.includes(kind))
    .map((kind) => ({
      value: kind,
      label: kind === "teams" ? "Teams" : `${kind[0]?.toUpperCase()}${kind.slice(1)}`,
    }));

  const removeDestination = (kind: ScheduleDeliveryKind) => {
    setDraft({
      ...draft,
      kinds: draft.kinds.filter((selected) => selected !== kind),
      ...(kind === "slack" ? { slackChannelId: "" } : {}),
      ...(kind === "telegram" ? { telegramChatId: "", telegramThreadId: "" } : {}),
      ...(kind === "teams" ? { teamsConversationId: "" } : {}),
    });
  };

  return (
    <Stack gap="xs">
      <Text fw={500} fz="sm">
        {t("trigger.destinations")}
      </Text>
      <Text fz="xs" c="dimmed">
        {t("trigger.destinationHint")}
      </Text>
      {destinationKinds.length > 0 && (
        <Group align="flex-end" gap="sm">
          <Select
            label={t("trigger.destinationType")}
            data={destinationKinds}
            value={kindToAdd}
            onChange={(value) => setKindToAdd(value as ScheduleDeliveryKind | null)}
            w={220}
          />
          <Button
            variant="default"
            disabled={!kindToAdd}
            onClick={() => {
              if (!kindToAdd) {
                return;
              }
              setDraft({ ...draft, kinds: [...draft.kinds, kindToAdd] });
              setKindToAdd(null);
            }}
          >
            {t("trigger.addDestination")}
          </Button>
        </Group>
      )}
      {draft.kinds.includes("slack") && slackChannelsUnavailable && (
        <Alert color="yellow" variant="light" p="xs">
          {t("trigger.slackUnavailable")}
        </Alert>
      )}
      {draft.kinds.map((kind) => (
        <Group key={kind} align="flex-end" gap="sm">
          <Text fw={600} fz="sm" w={80} pb={8}>
            {kind === "teams" ? "Teams" : `${kind[0]?.toUpperCase()}${kind.slice(1)}`}
          </Text>
          {kind === "slack" && (
            <Select
              label={t("trigger.slackChannel")}
              data={channelData}
              value={draft.slackChannelId || null}
              onChange={(value) => setDraft({ ...draft, slackChannelId: value ?? "" })}
              searchable
              disabled={slackChannelsUnavailable && !draft.slackChannelId}
              style={{ flex: 1 }}
            />
          )}
          {kind === "telegram" && (
            <>
              <TextInput
                label={t("trigger.telegramChatId")}
                value={draft.telegramChatId}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft({ ...draft, telegramChatId: value });
                }}
                error={!telegramValid}
                style={{ flex: 1 }}
              />
              <TextInput
                label={t("trigger.telegramThreadId")}
                value={draft.telegramThreadId}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft({ ...draft, telegramThreadId: value });
                }}
                style={{ flex: 1 }}
              />
            </>
          )}
          {kind === "teams" && (
            <TextInput
              label={t("trigger.teamsConversationId")}
              value={draft.teamsConversationId}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft({ ...draft, teamsConversationId: value });
              }}
              style={{ flex: 1 }}
            />
          )}
          <Button variant="default" color="red" onClick={() => removeDestination(kind)}>
            {t("trigger.removeDestination")}
          </Button>
        </Group>
      ))}
      <Group justify="space-between" gap="md" align="center" w="100%">
        <Button
          variant="default"
          size="xs"
          disabled={busy || !dirty || !destinationsValid}
          onClick={() => {
            const deliveries: ScheduleDelivery[] = [];
            if (draft.kinds.includes("slack")) {
              deliveries.push({ kind: "slack", channelId: draft.slackChannelId });
            }
            if (draft.kinds.includes("telegram")) {
              deliveries.push({
                kind: "telegram",
                chatId,
                ...(telegramThreadId ? { threadId } : {}),
              });
            }
            if (draft.kinds.includes("teams")) {
              deliveries.push({
                kind: "teams",
                conversationId: draft.teamsConversationId.trim(),
              });
            }
            onSave(deliveries);
          }}
        >
          {t("trigger.saveDestinations")}
        </Button>
        {actions}
      </Group>
    </Stack>
  );
}
