"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, NumberInput, Select, Stack, Text, TextInput } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { stateColor } from "@/app/_components/badgeColors";
import {
  getProject,
  listProjectTelegramChats,
  listProjectSlackChannels,
  updateProject,
  type CostLimits,
  type SlackChannelInfo,
  type TelegramDestination,
} from "../../lib/api";
import { useT } from "@/app/_i18n/provider";
import { costAlertDestinations } from "@/domain/project/types";
import type {
  MessageDestination,
  MessageDestinationKind,
} from "@/domain/messaging/destination";
import {
  findTelegramDestination,
  telegramDestinationLabel,
  telegramDestinationValue,
} from "./telegramDestinations";

export function costLimitsForSave(limits: CostLimits): CostLimits | null {
  const hasThreshold =
    limits.alertThresholdUsd !== undefined ||
    limits.blockThresholdUsd !== undefined ||
    limits.monthlyAlertThresholdUsd !== undefined ||
    limits.monthlyBlockThresholdUsd !== undefined;
  const hasDestination = (limits.alertDestinations?.length ?? 0) > 0;
  return hasThreshold || hasDestination ? limits : null;
}

/**
 * Daily and monthly (UTC) spend guards. Four independent thresholds and the
 * channel their notifications go to.
 *
 * An empty field means "no limit" rather than zero — a zero block threshold
 * would refuse every run, which is never what clearing a box is meant to say.
 */
export function CostLimitsSection({ projectName }: { projectName: string }) {
  const t = useT();
  const [alertUsd, setAlertUsd] = useState<number | "">("");
  const [blockUsd, setBlockUsd] = useState<number | "">("");
  const [monthlyAlertUsd, setMonthlyAlertUsd] = useState<number | "">("");
  const [monthlyBlockUsd, setMonthlyBlockUsd] = useState<number | "">("");
  const [destinations, setDestinations] = useState<MessageDestination[]>([]);
  const [slackChannels, setSlackChannels] = useState<SlackChannelInfo[]>([]);
  const [telegramChats, setTelegramChats] = useState<TelegramDestination[]>([]);
  const [slackChannelsUnavailable, setSlackChannelsUnavailable] = useState(false);
  const [slackChannelsLoading, setSlackChannelsLoading] = useState(true);
  const [availableDestinations, setAvailableDestinations] = useState<
    MessageDestinationKind[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const project = await getProject(projectName);
      if (cancelled) {
        return;
      }
      const limits = project.costLimits;
      setAlertUsd(limits?.alertThresholdUsd ?? "");
      setBlockUsd(limits?.blockThresholdUsd ?? "");
      setMonthlyAlertUsd(limits?.monthlyAlertThresholdUsd ?? "");
      setMonthlyBlockUsd(limits?.monthlyBlockThresholdUsd ?? "");
      setDestinations(limits ? costAlertDestinations(limits) : []);
      setLoading(false);

      // The project's own integration summaries say which surfaces exist, so
      // only those are asked anything further — an unconnected bot's channel
      // or chat listing is a guaranteed 400, fired on every settings visit.
      const slackOn = Boolean(project.slack?.configured && project.slack.enabled);
      const telegramOn = Boolean(project.telegram?.configured && project.telegram.enabled);
      const teamsOn = Boolean(project.teams?.configured && project.teams.enabled);
      const [slack, telegramDestinations] = await Promise.allSettled([
        slackOn ? listProjectSlackChannels(projectName) : Promise.resolve({ channels: [] }),
        telegramOn ? listProjectTelegramChats(projectName) : Promise.resolve({ chats: [] }),
      ]);
      if (cancelled) {
        return;
      }
      const channels = slack.status === "fulfilled" ? slack.value.channels : [];
      setSlackChannels(channels);
      setTelegramChats(
        telegramDestinations.status === "fulfilled" ? telegramDestinations.value.chats : [],
      );
      setSlackChannelsUnavailable(!slackOn || slack.status === "rejected" || channels.length === 0);
      setAvailableDestinations([
        ...(channels.length > 0 ? (["slack"] as const) : []),
        ...(telegramOn ? (["telegram"] as const) : []),
        ...(teamsOn ? (["teams"] as const) : []),
      ]);
    }
    void load()
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load cost limits");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setSlackChannelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const limits: CostLimits = {
      ...(alertUsd === "" ? {} : { alertThresholdUsd: alertUsd }),
      ...(blockUsd === "" ? {} : { blockThresholdUsd: blockUsd }),
      ...(monthlyAlertUsd === "" ? {} : { monthlyAlertThresholdUsd: monthlyAlertUsd }),
      ...(monthlyBlockUsd === "" ? {} : { monthlyBlockThresholdUsd: monthlyBlockUsd }),
      ...(destinations.length > 0 ? { alertDestinations: destinations } : {}),
    };
    try {
      // Destinations may be chosen before a threshold. Clear the stored object
      // only when both the thresholds and their future delivery targets are gone.
      await updateProject(projectName, { costLimits: costLimitsForSave(limits) });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save cost limits");
    } finally {
      setSaving(false);
    }
  }

  // Readable while collapsed: each configured window as `alert / block` with
  // its period, a dash for a threshold left open, `none` when the guard is off.
  // A monthly-only guard must not read as `– / –`, which says "off".
  const usd = (value: number | "") => (value === "" ? "–" : `$${value}`);
  const windowSummary = (alert: number | "", block: number | "", period: string) =>
    alert === "" && block === "" ? null : `${usd(alert)} / ${usd(block)}${period}`;
  const summary = [
    windowSummary(alertUsd, blockUsd, "/day"),
    windowSummary(monthlyAlertUsd, monthlyBlockUsd, "/mo"),
  ]
    .filter(Boolean)
    .join(" · ");
  const configured = summary !== "";
  const slackDestination = destinations.find((destination) => destination.kind === "slack");
  const listedChannels = slackChannels.map((slackChannel) => ({
    value: slackChannel.id,
    label: `#${slackChannel.name}${slackChannel.isPrivate ? " (private)" : ""}`,
  }));
  const channelData =
    slackDestination?.kind === "slack" &&
    !listedChannels.some((item) => item.value === slackDestination.channelId)
      ? [
          { value: slackDestination.channelId, label: slackDestination.channelId },
          ...listedChannels,
        ]
      : listedChannels;
  const telegramData = telegramChats.map((destination) => ({
    value: telegramDestinationValue(destination),
    label: telegramDestinationLabel(destination),
  }));
  const destinationKinds = availableDestinations
    .filter((kind) => !destinations.some((destination) => destination.kind === kind))
    .map((kind) => ({
      value: kind,
      label: kind === "teams" ? "Teams" : `${kind[0]?.toUpperCase()}${kind.slice(1)}`,
    }));
  const destinationsValid = destinations.every((destination) => {
    if (destination.kind === "slack") {
      return Boolean(destination.channelId);
    }
    if (destination.kind === "telegram") {
      return (
        Number.isSafeInteger(destination.chatId) &&
        destination.chatId !== 0 &&
        (destination.threadId === undefined ||
          (Number.isSafeInteger(destination.threadId) && destination.threadId > 0))
      );
    }
    return Boolean(destination.conversationId.trim());
  });

  const addDestination = (kind: MessageDestinationKind) => {
    const destination: MessageDestination =
      kind === "slack"
        ? { kind, channelId: "" }
        : kind === "telegram"
          ? telegramChats.length === 1
            ? {
                kind,
                chatId: telegramChats[0]!.chatId,
                ...(telegramChats[0]!.threadId === undefined
                  ? {}
                  : { threadId: telegramChats[0]!.threadId }),
              }
            : { kind, chatId: 0 }
          : { kind, conversationId: "" };
    setDestinations((current) => [...current, destination]);
  };

  return (
    <CollapsibleSection
      title={t("pset.costLimits")}
      badge={
        loading ? undefined : (
          <Badge color={stateColor(configured)} radius="xl">
            {configured ? summary : "none"}
          </Badge>
        )
      }
    >
      <Stack gap="md">
        <Text fz="sm" c="dimmed">
          Spend is measured per UTC day and per UTC month across every model this project runs.
          Leave a field empty for no limit. A blocked project refuses every run — API, chat,
          Slack and A2A alike — until the window rolls over: 00:00 UTC for the day, the first
          of the next month for the month.
        </Text>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group grow align="flex-start">
          <NumberInput
            label={t("pset.alertThreshold")}
            description={t("pset.alertThresholdHint")}
            value={alertUsd}
            onChange={(value) => setAlertUsd(value === "" ? "" : Number(value))}
            min={0}
            step={1}
            decimalScale={2}
            disabled={loading}
          />
          <NumberInput
            label={t("pset.blockThreshold")}
            description={t("pset.blockThresholdHint")}
            value={blockUsd}
            onChange={(value) => setBlockUsd(value === "" ? "" : Number(value))}
            min={0}
            step={1}
            decimalScale={2}
            disabled={loading}
          />
        </Group>
        <Group grow align="flex-start">
          <NumberInput
            label={t("pset.monthlyAlert")}
            description={t("pset.monthlyAlertHint")}
            value={monthlyAlertUsd}
            onChange={(value) => setMonthlyAlertUsd(value === "" ? "" : Number(value))}
            min={0}
            step={10}
            decimalScale={2}
            disabled={loading}
          />
          <NumberInput
            label={t("pset.monthlyBlock")}
            description={t("pset.monthlyBlockHint")}
            value={monthlyBlockUsd}
            onChange={(value) => setMonthlyBlockUsd(value === "" ? "" : Number(value))}
            min={0}
            step={10}
            decimalScale={2}
            disabled={loading}
          />
        </Group>
        <Stack gap="xs">
          <Text fw={500} fz="sm">
            {t("pset.notificationDestinations")}
          </Text>
          <Text fz="xs" c="dimmed">
            {t("pset.notificationDestinationsHint")}
          </Text>
          {destinationKinds.length > 0 && (
            <Select
              label={t("trigger.addDestination")}
              placeholder={t("trigger.destinationType")}
              data={destinationKinds}
              value={null}
              onChange={(value) => {
                const kind = value as MessageDestinationKind | null;
                if (kind) {
                  addDestination(kind);
                }
              }}
              w={220}
            />
          )}
          {destinations.map((destination) => (
            <Group key={destination.kind} align="flex-end" gap="sm">
              <Text fw={600} fz="sm" w={80} pb={8}>
                {destination.kind === "teams"
                  ? "Teams"
                  : `${destination.kind[0]?.toUpperCase()}${destination.kind.slice(1)}`}
              </Text>
              {destination.kind === "slack" && (
                <Select
                  label={t("pset.slackChannel")}
                  placeholder={
                    slackChannelsUnavailable ? t("pset.slackChannelUnavailable") : undefined
                  }
                  data={channelData}
                  value={destination.channelId || null}
                  onChange={(value) =>
                    setDestinations((current) =>
                      current.map((item) =>
                        item.kind === "slack" ? { ...item, channelId: value ?? "" } : item,
                      ),
                    )
                  }
                  searchable
                  disabled={slackChannelsLoading || slackChannelsUnavailable}
                  style={{ flex: 1 }}
                />
              )}
              {destination.kind === "telegram" && (
                <Stack gap="xs" style={{ flex: 1 }}>
                  <Select
                    label={t("trigger.telegramObservedDestination")}
                    description={t("trigger.telegramObservedDestinationHint")}
                    placeholder={t("trigger.telegramObservedDestinationPlaceholder")}
                    data={telegramData}
                    value={
                      telegramChats.some(
                        (chat) =>
                          chat.chatId === destination.chatId &&
                          chat.threadId === destination.threadId,
                      )
                        ? telegramDestinationValue(destination)
                        : null
                    }
                    onChange={(value) => {
                      const selected = findTelegramDestination(telegramChats, value);
                      if (selected) {
                        setDestinations((current) =>
                          current.map((item) =>
                            item.kind === "telegram"
                              ? {
                                  ...item,
                                  chatId: selected.chatId,
                                  threadId: selected.threadId,
                                }
                              : item,
                          ),
                        );
                      }
                    }}
                    searchable
                    disabled={telegramChats.length === 0}
                  />
                  <Group grow align="flex-start" gap="sm">
                    <NumberInput
                      label={t("trigger.telegramChatId")}
                      description={t("trigger.telegramChatIdHint")}
                      value={destination.chatId || ""}
                      onChange={(value) =>
                        setDestinations((current) =>
                          current.map((item) =>
                            item.kind === "telegram"
                              ? { ...item, chatId: typeof value === "number" ? value : 0 }
                              : item,
                          ),
                        )
                      }
                      allowDecimal={false}
                    />
                    <NumberInput
                      label={t("trigger.telegramThreadId")}
                      value={destination.threadId ?? ""}
                      onChange={(value) =>
                        setDestinations((current) =>
                          current.map((item) =>
                            item.kind === "telegram"
                              ? {
                                  ...item,
                                  ...(typeof value === "number"
                                    ? { threadId: value }
                                    : { threadId: undefined }),
                                }
                              : item,
                          ),
                        )
                      }
                      min={1}
                      allowDecimal={false}
                    />
                  </Group>
                </Stack>
              )}
              {destination.kind === "teams" && (
                <TextInput
                  label={t("trigger.teamsConversationId")}
                  description={t("trigger.teamsConversationIdHint")}
                  value={destination.conversationId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDestinations((current) =>
                      current.map((item) =>
                        item.kind === "teams" ? { ...item, conversationId: value } : item,
                      ),
                    );
                  }}
                  style={{ flex: 1 }}
                />
              )}
              <Button
                variant="default"
                color="red"
                onClick={() =>
                  setDestinations((current) =>
                    current.filter((item) => item.kind !== destination.kind),
                  )
                }
              >
                Remove
              </Button>
            </Group>
          ))}
        </Stack>
        <Group gap="sm">
          <Button onClick={save} loading={saving} disabled={loading || !destinationsValid}>
            Save cost limits
          </Button>
          {saved && (
            <Text fz="sm" c="teal">
              Saved
            </Text>
          )}
        </Group>
      </Stack>
    </CollapsibleSection>
  );
}
