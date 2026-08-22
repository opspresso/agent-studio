"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useConfirm } from "@/app/_components/useConfirm";
import { Alert, Badge, Button, Group, Paper, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { stateColor } from "@/app/_components/badgeColors";
import { PROJECT_WEBHOOK_ID } from "@/domain/trigger/types";
import type { ScheduleDelivery, ScheduleDeliveryKind } from "@/domain/trigger/types";
import { toSlug } from "@/domain/naming";
import { useT } from "@/app/_i18n/provider";
import { TriggerRuns } from "./TriggerRuns";
import {
  createTrigger,
  deleteTrigger,
  getProjectTeams,
  getProjectTelegram,
  listProjectTelegramChats,
  listTriggerRuns,
  listProjectSlackChannels,
  listTriggers,
  updateTrigger,
  type TriggerRun,
  type TriggerView,
  type SlackChannelInfo,
  type TelegramDestination,
} from "../../lib/api";
import {
  findTelegramDestination,
  telegramDestinationLabel,
  telegramDestinationValue,
} from "./telegramDestinations";
import { reportError } from "@/app/_lib/reportError";

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
  const [telegramChats, setTelegramChats] = useState<TelegramDestination[]>([]);
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
      listProjectTelegramChats(projectName),
      getProjectTeams(projectName),
    ]).then(([slack, telegram, telegramDestinations, teams]) => {
      if (cancelled) {
        return;
      }
      const channels = slack.status === "fulfilled" ? slack.value.channels : [];
      setSlackChannels(channels);
      setTelegramChats(
        telegramDestinations.status === "fulfilled" ? telegramDestinations.value.chats : [],
      );
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
      setError(reportError(e, "Failed"));
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
              <ScheduleEditor
                schedule={schedule}
                slackChannels={slackChannels}
                slackChannelsUnavailable={slackChannelsUnavailable}
                telegramChats={telegramChats}
                availableDestinations={availableDestinations}
                busy={busy}
                onSave={(input) =>
                  act(async () => {
                    await updateTrigger(projectName, schedule.triggerId, input);
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

interface DestinationDraft {
  kinds: ScheduleDeliveryKind[];
  slackChannelId: string;
  telegramChatId: string;
  telegramThreadId: string;
  teamsConversationId: string;
}

interface ScheduleDraft extends DestinationDraft {
  cron: string;
  timezone: string;
  message: string;
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

function scheduleDraft(schedule: TriggerView): ScheduleDraft {
  return {
    cron: schedule.cron ?? "",
    timezone: schedule.timezone ?? "",
    message: schedule.message ?? "",
    ...destinationDraft(schedule.deliveries),
  };
}

function sameScheduleDraft(a: ScheduleDraft, b: ScheduleDraft): boolean {
  return (
    a.cron === b.cron &&
    a.timezone === b.timezone &&
    a.message === b.message &&
    sameDestinations(a, b)
  );
}

/**
 * One draft and one Save for every schedule setting. Enabled and overlap still
 * save immediately; their reloads do not discard an in-progress draft.
 */
function ScheduleEditor({
  schedule,
  slackChannels,
  slackChannelsUnavailable,
  telegramChats,
  availableDestinations,
  busy,
  onSave,
  actions,
}: {
  schedule: TriggerView;
  slackChannels: SlackChannelInfo[];
  slackChannelsUnavailable: boolean;
  telegramChats: TelegramDestination[];
  availableDestinations: ScheduleDeliveryKind[];
  busy: boolean;
  onSave: (input: {
    cron: string;
    timezone: string;
    message: string;
    deliveries: ScheduleDelivery[];
  }) => void;
  actions: ReactNode;
}) {
  const t = useT();
  const server = scheduleDraft(schedule);
  const [draft, setDraft] = useState(server);
  const [seen, setSeen] = useState(server);
  if (!sameScheduleDraft(server, seen)) {
    setSeen(server);
    if (sameScheduleDraft(draft, seen)) {
      setDraft(server);
    }
  }
  const telegramChatId = draft.telegramChatId.trim();
  const telegramThreadId = draft.telegramThreadId.trim();
  const chatId = Number(telegramChatId);
  const threadId = Number(telegramThreadId);
  const telegramValid =
    (!draft.kinds.includes("telegram") ||
      (Boolean(telegramChatId) && Number.isSafeInteger(chatId) && chatId !== 0)) &&
    (!telegramThreadId || (Number.isSafeInteger(threadId) && threadId > 0)) &&
    (!telegramThreadId || Boolean(telegramChatId));
  const destinationsValid =
    telegramValid &&
    (!draft.kinds.includes("slack") || Boolean(draft.slackChannelId)) &&
    (!draft.kinds.includes("teams") || Boolean(draft.teamsConversationId.trim()));
  const dirty = !sameScheduleDraft(draft, server);
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
  const telegramData = telegramChats.map((destination) => ({
    value: telegramDestinationValue(destination),
    label: telegramDestinationLabel(destination),
  }));
  const selectedTelegram = telegramChats.find(
    (destination) =>
      destination.chatId === chatId &&
      (destination.threadId === undefined ? "" : String(destination.threadId)) === telegramThreadId,
  );
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
    <Stack gap="sm">
      <Group align="flex-end" gap="sm">
        <TextInput
          label={t("trigger.cron")}
          description={t("trigger.cronHint")}
          inputWrapperOrder={["label", "description", "input", "error"]}
          value={draft.cron}
          onChange={(event) => {
            const cron = event.currentTarget.value;
            setDraft({ ...draft, cron });
          }}
          w={180}
        />
        <TextInput
          label={t("trigger.timezone")}
          value={draft.timezone}
          onChange={(event) => {
            const timezone = event.currentTarget.value;
            setDraft({ ...draft, timezone });
          }}
          w={180}
        />
        <TextInput
          label={t("trigger.message")}
          placeholder={t("trigger.messagePlaceholder")}
          value={draft.message}
          onChange={(event) => {
            const message = event.currentTarget.value;
            setDraft({ ...draft, message });
          }}
          style={{ flex: 1 }}
        />
      </Group>
      <Text fw={500} fz="sm">
        {t("trigger.destinations")}
      </Text>
      <Text fz="xs" c="dimmed">
        {t("trigger.destinationHint")}
      </Text>
      {destinationKinds.length > 0 && (
        <Select
          label={t("trigger.addDestination")}
          placeholder={t("trigger.destinationType")}
          data={destinationKinds}
          value={null}
          onChange={(value) => {
            const kind = value as ScheduleDeliveryKind | null;
            if (kind) {
              const destination = kind === "telegram" && telegramChats.length === 1
                ? telegramChats[0]
                : undefined;
              setDraft({
                ...draft,
                kinds: [...draft.kinds, kind],
                ...(destination
                  ? {
                      telegramChatId: String(destination.chatId),
                      telegramThreadId:
                        destination.threadId === undefined ? "" : String(destination.threadId),
                    }
                  : {}),
              });
            }
          }}
          w={220}
        />
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
            <Stack gap="xs" style={{ flex: 1 }}>
              <Select
                label={t("trigger.telegramObservedDestination")}
                description={t("trigger.telegramObservedDestinationHint")}
                placeholder={t("trigger.telegramObservedDestinationPlaceholder")}
                data={telegramData}
                value={selectedTelegram ? telegramDestinationValue(selectedTelegram) : null}
                onChange={(value) => {
                  const destination = findTelegramDestination(telegramChats, value);
                  if (destination) {
                    setDraft({
                      ...draft,
                      telegramChatId: String(destination.chatId),
                      telegramThreadId:
                        destination.threadId === undefined ? "" : String(destination.threadId),
                    });
                  }
                }}
                searchable
                disabled={telegramChats.length === 0}
              />
              <Group grow align="flex-start" gap="sm">
                <TextInput
                  label={t("trigger.telegramChatId")}
                  description={t("trigger.telegramChatIdHint")}
                  value={draft.telegramChatId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft({ ...draft, telegramChatId: value });
                  }}
                  error={!telegramValid}
                />
                <TextInput
                  label={t("trigger.telegramThreadId")}
                  value={draft.telegramThreadId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft({ ...draft, telegramThreadId: value });
                  }}
                />
              </Group>
            </Stack>
          )}
          {kind === "teams" && (
            <TextInput
              label={t("trigger.teamsConversationId")}
              description={t("trigger.teamsConversationIdHint")}
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
          disabled={
            busy ||
            !dirty ||
            !draft.cron.trim() ||
            !draft.timezone.trim() ||
            !destinationsValid
          }
          onClick={() => {
            const deliveries: ScheduleDelivery[] = [
              ...(draft.kinds.includes("slack")
                ? [{ kind: "slack" as const, channelId: draft.slackChannelId }]
                : []),
              ...(draft.kinds.includes("telegram")
                ? [
                    {
                      kind: "telegram" as const,
                      chatId,
                      ...(telegramThreadId ? { threadId } : {}),
                    },
                  ]
                : []),
              ...(draft.kinds.includes("teams")
                ? [
                    {
                      kind: "teams" as const,
                      conversationId: draft.teamsConversationId.trim(),
                    },
                  ]
                : []),
            ];
            onSave({
              cron: draft.cron.trim(),
              timezone: draft.timezone.trim(),
              message: draft.message,
              deliveries,
            });
          }}
        >
          {t("trigger.saveScheduleSettings")}
        </Button>
        {actions}
      </Group>
    </Stack>
  );
}
