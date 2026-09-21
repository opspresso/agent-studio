"use client";

import { Stack } from "@mantine/core";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useCallback } from "react";
import { useParams } from "next/navigation";
import { ArtifactGallery } from "@/app/artifacts/_components/ArtifactGallery";
import { listProjectArtifacts, type ArtifactQuery } from "@/app/artifacts/api";
import { useT } from "@/app/_i18n/provider";

/**
 * Everything this project produced, including outputs without a personal owner.
 * Personal-context automation also appears in its owner's personal gallery.
 */
export default function ProjectArtifactsPage() {
  const t = useT();
  const { name } = useParams<{ name: string }>();
  const load = useCallback(
    (query: ArtifactQuery) => listProjectArtifacts(name, query),
    [name],
  );
  return (
    <Stack gap="lg">
      <SectionHeading title={t("project.tab.artifacts")} />
    <ArtifactGallery
      load={load}
      showProject={false}
      emptyText={t("projectArtifacts.empty")}
    />
    </Stack>
  );
}
