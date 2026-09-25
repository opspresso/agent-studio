"use client";

import { Stack } from "@mantine/core";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useCallback } from "react";
import { useParams } from "next/navigation";
import { ArtifactGallery } from "@/app/artifacts/_components/ArtifactGallery";
import { listAgentArtifacts, type ArtifactQuery } from "@/app/artifacts/api";
import { useT } from "@/app/_i18n/provider";

/**
 * Everything this agent produced, including outputs without a personal owner.
 * Personal-context automation also appears in its owner's personal gallery.
 */
export default function AgentArtifactsPage() {
  const t = useT();
  const { name } = useParams<{ name: string }>();
  const load = useCallback(
    (query: ArtifactQuery) => listAgentArtifacts(name, query),
    [name],
  );
  return (
    <Stack gap="lg">
      <SectionHeading title={t("agent.tab.artifacts")} />
    <ArtifactGallery
      load={load}
      showAgent={false}
      emptyText={t("agentArtifacts.empty")}
    />
    </Stack>
  );
}
