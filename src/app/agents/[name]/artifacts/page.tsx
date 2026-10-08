"use client";

import { Button, Stack } from "@mantine/core";
import Link from "next/link";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useCallback } from "react";
import { useParams } from "next/navigation";
import { ArtifactGallery } from "@/app/artifacts/_components/ArtifactGallery";
import { listAgentArtifacts, type ArtifactQuery } from "@/app/artifacts/api";
import { useT } from "@/app/_i18n/provider";

/**
 * General Agent output. Private audio files stay in their owner's personal gallery.
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
      <SectionHeading title={t("agent.tab.artifacts")} description={t("agentArtifacts.privateFiles")}>
        <Button component={Link} href="/artifacts" variant="light" size="xs">
          {t("agentArtifacts.openMine")}
        </Button>
      </SectionHeading>
      <ArtifactGallery
        load={load}
        showAgent={false}
        emptyText={t("agentArtifacts.empty")}
      />
    </Stack>
  );
}
