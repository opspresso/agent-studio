"use client";

import { useEffect, useState } from "react";
import { Alert, Stack } from "@mantine/core";
import { IconCpu } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { useT } from "@/app/_i18n/provider";
import { listRegisteredModels } from "./api";
import type { RegisteredModel } from "@/domain/llm/providerModels";
import { ModelCollection } from "./ModelCollection";

export default function ModelsPage() {
  const t = useT();
  const [models, setModels] = useState<RegisteredModel[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    void listRegisteredModels()
      .then(value => { if (current) setModels(value); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { current = false; };
  }, []);
  return <Stack gap="lg">
    <PageHeader title={t("nav.models")} description={t("modelAdmin.onlySelected")} Icon={IconCpu} />
    {error && <Alert color="red">{error}</Alert>}
    {!models && !error && <LoadingText />}
    {models && <ModelCollection scope="browse" models={models} emptyText={t("models.empty")} />}
  </Stack>;
}
