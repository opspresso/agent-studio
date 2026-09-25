"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Stack } from "@mantine/core";
import { canEditAgent, useViewer } from "@/app/_lib/useViewer";
import { getAgent } from "../../lib/api";
import { LoadingText } from "@/app/_components/PageState";
import { SlackSection } from "./SlackSection";
import { TeamsSection } from "./TeamsSection";
import { TelegramSection } from "./TelegramSection";
import { TokenSection } from "./TokenSection";
import { useT } from "@/app/_i18n/provider";

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
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAgent(name)
      .then((agent) => {
        if (!cancelled) {
          setOwnerEmail(agent.ownerEmail);
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
      <Alert color="red" variant="light" maw={640}>
        {error}
      </Alert>
    );
  }
  if (viewer === null) {
    return <LoadingText />;
  }
  if (!canEditAgent(viewer, ownerEmail)) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        {t("pint.ownerOnly", { owner: ownerEmail ?? "unknown" })}
      </Alert>
    );
  }

  return (
    <Stack gap="xl" maw={760}>
      <SectionHeading title={t("agent.tab.integrations")} description={t("pint.lede")} />
      <TokenSection agentName={name} />

      <SlackSection agentName={name} />

      <TelegramSection agentName={name} />

      <TeamsSection agentName={name} />

    </Stack>
  );
}
