"use client";

import { useCallback } from "react";
import { Stack } from "@mantine/core";
import { IconPhoto } from "@tabler/icons-react";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { ArtifactGallery } from "./_components/ArtifactGallery";
import { listMyArtifacts, type ArtifactQuery } from "./api";

export default function ArtifactsPage() {
  const load = useCallback((query: ArtifactQuery) => listMyArtifacts(query), []);
  return (
    <Stack gap="lg">
      <CatalogHeader
        title="Artifacts"
        description="Images and documents your runs produced. A run started by Slack, a trigger or an A2A call belongs to its project — those are on the project's own tab."
        Icon={IconPhoto}
      />
      <ArtifactGallery
        load={load}
        emptyText="Nothing kept yet. Images and documents your runs produce show up here."
      />
    </Stack>
  );
}
