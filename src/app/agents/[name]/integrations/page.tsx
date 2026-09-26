"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Stack } from "@mantine/core";
import { canEditAgent, useViewer } from "@/app/_lib/useViewer";
import { getAgent, type SanitizedAgent } from "../../lib/api";
import { LoadingText } from "@/app/_components/PageState";
import { SlackSection } from "./SlackSection";
import { TeamsSection } from "./TeamsSection";
import { TelegramSection } from "./TelegramSection";
import { TokenSection } from "./TokenSection";
import { WebhookSection } from "./WebhookSection";
import { SchedulesSection } from "./SchedulesSection";
import { useT } from "@/app/_i18n/provider";
import columns from "../AgentPageColumns.module.css";

/**
 * How other systems reach this agent: the API token an outside caller
 * presents and the chat platforms whose bots run it.
 * Split out of Settings once the bots outnumbered everything else on that
 * page — what the agent *is* stays there; what connects to it is here.
 */
export default function IntegrationsPage() {
  const t = useT();
  const params = useParams<{ name: string }>();
  const name = params.name;
  const viewer = useViewer();
  const [agent, setAgent] = useState<SanitizedAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAgent(name)
      .then((loaded) => {
        if (!cancelled) {
          setAgent(loaded);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load agent"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (loading) {
    return <LoadingText />;
  }
  if (error) {
    return (
      <div className={columns.split}>
        <Alert color="red" variant="light" className={columns.primary}>{error}</Alert>
      </div>
    );
  }
  if (viewer === null) {
    return <LoadingText />;
  }
  if (!agent) return <LoadingText />;
  if (!canEditAgent(viewer, agent.ownerEmail)) {
    return (
      <div className={columns.split}>
        <Alert variant="light" color="gray" className={columns.primary}>
          {t("pint.ownerOnly", { owner: agent.ownerEmail })}
        </Alert>
      </div>
    );
  }

  return (
    <div className={columns.split}>
      <Stack gap="xl" className={columns.primary}>
        <SectionHeading title={t("agent.tab.integrations")} description={t("pint.lede")} />
        <TokenSection agentName={name} />
        <SlackSection agentName={name} />
        <TelegramSection agentName={name} />
        <TeamsSection agentName={name} />
        <WebhookSection agentName={name} />
        <SchedulesSection key={`schedules:${name}`} agentName={name} agent={agent} />
      </Stack>
    </div>
  );
}
