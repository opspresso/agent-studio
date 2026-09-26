"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Stack, Text, Title } from "@mantine/core";
import { useLocale, useT } from "@/app/_i18n/provider";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { formatDateTime } from "@/shared/date";
import { AGENT_WEBHOOK_ID } from "@/domain/trigger/types";
import { listTraces, listTriggerRuns, listTriggers, type Trace, type TriggerRun } from "../../lib/api";
import { loadScheduleRuns } from "./scheduleRuns";
import { TriggerRuns } from "./TriggerRuns";
import classes from "./IntegrationHistory.module.css";

export type IntegrationKind = "token" | "slack" | "telegram" | "teams" | "webhook" | "schedule";

const LABEL: Record<IntegrationKind, MessageKey> = {
  token: "pset.apiToken",
  slack: "pset.slackBot",
  telegram: "pset.telegramBot",
  teams: "pset.teamsBot",
  webhook: "webhook.section",
  schedule: "schedule.section",
};

const TRACE_ACTOR = {
  token: "agent-token",
  slack: "slack",
  telegram: "telegram",
  teams: "teams",
} as const;

type History = { kind: "trace"; traces: Trace[] } | { kind: "trigger"; runs: TriggerRun[] };

async function readHistory(agentName: string, selected: IntegrationKind): Promise<History> {
  if (selected in TRACE_ACTOR) {
    const actorKind = TRACE_ACTOR[selected as keyof typeof TRACE_ACTOR];
    const { traces } = await listTraces(agentName, { actorKind });
    return { kind: "trace", traces };
  }
  const { triggers } = await listTriggers(agentName);
  if (selected === "webhook") {
    const webhook = triggers.find(trigger => trigger.kind === "webhook" && trigger.triggerId === AGENT_WEBHOOK_ID);
    const runs = webhook ? (await listTriggerRuns(agentName, webhook.triggerId)).runs : [];
    return { kind: "trigger", runs };
  }
  const schedules = triggers.filter(trigger => trigger.kind === "schedule");
  const grouped = await loadScheduleRuns(agentName, schedules);
  const runs = Object.values(grouped).flat().sort((a, b) =>
    (b.queuedAt ?? b.startedAt ?? b.scheduledFor ?? "").localeCompare(a.queuedAt ?? a.startedAt ?? a.scheduledFor ?? ""));
  return { kind: "trigger", runs: runs.slice(0, 50) };
}

export function IntegrationHistory({ agentName, selected }: { agentName: string; selected: IntegrationKind | null }) {
  const t = useT();
  const locale = useLocale();
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setHistory(null);
    setError(null);
    if (!selected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void readHistory(agentName, selected)
      .then(value => { if (current) setHistory(value); })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : t("pint.historyFailed")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [agentName, selected, revision, t]);

  return <aside className={classes.panel} aria-label={t("pint.historyTitle")}>
    <div className={classes.header}>
      <div>
        <Title order={3} fz="lg">{t("pint.historyTitle")}</Title>
        <Text fz="sm" c="dimmed" mt={4}>{selected ? t(LABEL[selected]) : t("pint.historyChoose")}</Text>
      </div>
      {selected && <Button variant="subtle" size="compact-sm" onClick={() => setRevision(value => value + 1)}>
        {t("pint.historyRefresh")}
      </Button>}
    </div>
    {!selected ? null : loading ? <Text fz="sm" c="dimmed" mt="lg">{t("common.loading")}</Text>
      : error ? <Alert color="red" mt="lg">{error}</Alert>
      : history?.kind === "trigger" ? history.runs.length > 0
        ? <TriggerRuns runs={history.runs} showTriggerId={selected === "schedule"} />
        : <Text fz="sm" c="dimmed" mt="lg">{t("pint.historyEmpty")}</Text>
      : history?.kind === "trace" ? <Stack gap="xs" mt="md">
          <Text fz="xs" c="dimmed">{t("pint.traceHistoryHint")}</Text>
          {history.traces.length === 0 ? <Text fz="sm" c="dimmed">{t("pint.historyEmpty")}</Text>
            : <div className={classes.rows}>{history.traces.map(trace => <Link className={classes.trace}
                href={`/agents/${agentName}/traces/${trace.traceId}`} key={trace.traceId}>
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Text fz="sm" fw={600}>{formatDateTime(trace.createdAt, locale)}</Text>
                  <Badge color={trace.status === "completed" ? "teal" : trace.status === "failed" ? "red" : "yellow"}>
                    {trace.status}
                  </Badge>
                </Group>
                <Text fz="xs" c="dimmed" mt={4}>{trace.durationMs} ms · {trace.traceId.slice(0, 8)}</Text>
                {(trace.error || trace.warnings?.[0]) && <Text fz="xs" c="dimmed" mt={4} lineClamp={2}>
                  {trace.error || trace.warnings?.[0]}
                </Text>}
              </Link>)}</div>}
        </Stack> : null}
  </aside>;
}
