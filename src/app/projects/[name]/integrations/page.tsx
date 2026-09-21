"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Stack, Text } from "@mantine/core";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { getProject } from "../../lib/api";
import { LoadingText } from "@/app/_components/PageState";
import { A2aSection } from "./A2aSection";
import { AguiSection } from "./AguiSection";
import { SlackSection } from "./SlackSection";
import { TeamsSection } from "./TeamsSection";
import { TelegramSection } from "./TelegramSection";
import { TokenSection } from "./TokenSection";
import { useT } from "@/app/_i18n/provider";

/**
 * How other systems reach this project: the API token an outside caller
 * presents, the chat platforms whose bots run it, and its A2A exposure.
 * Split out of Settings once the bots outnumbered everything else on that
 * page — what the project *is* stays there; what connects to it is here.
 */
export default function IntegrationsPage() {
  const t = useT();
  const params = useParams<{ name: string }>();
  const name = params.name;
  const viewer = useViewer();
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProject(name)
      .then((project) => {
        if (!cancelled) {
          setOwnerEmail(project.ownerEmail);
          setConfigured(Boolean(project.configured));
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load project"))
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
  if (!canEditProject(viewer, ownerEmail)) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        {t("pint.ownerOnly", { owner: ownerEmail ?? "unknown" })}
      </Alert>
    );
  }

  return (
    <Stack gap="xl" maw={760}>
      <Text fz="sm" c="dimmed">
        {t("pint.lede")}
      </Text>
      <TokenSection projectName={name} />

      <SlackSection projectName={name} />

      <TelegramSection projectName={name} />

      <TeamsSection projectName={name} />

      <A2aSection projectName={name} />

      <AguiSection projectName={name} configured={configured} />
    </Stack>
  );
}
