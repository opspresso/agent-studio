"use client";

import { useCallback } from "react";
import { Stack } from "@mantine/core";
import { IconPhoto } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import { ArtifactGallery } from "./_components/ArtifactGallery";
import { listMyArtifacts, type ArtifactQuery } from "./api";
import { useT } from "@/app/_i18n/provider";

export default function ArtifactsPage() {
  const t = useT();
  const load = useCallback((query: ArtifactQuery) => listMyArtifacts(query), []);
  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.artifacts")}
        description={t("artifacts.lede")}
        Icon={IconPhoto}
      />
      <ArtifactGallery
        load={load}
        emptyText={t("artifacts.empty")}
      />
    </Stack>
  );
}
