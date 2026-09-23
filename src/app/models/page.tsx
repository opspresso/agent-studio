"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Stack } from "@mantine/core";
import { IconCpu, IconStar, IconStarFilled } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import type { ModelFavoritesResponse } from "@/app/api/models/favorites/route";
import type { RegisteredModel } from "@/domain/llm/providerModels";
import { listRegisteredModels } from "./api";
import { ModelCollection } from "./ModelCollection";

export default function ModelsPage() {
  const t = useT();
  const [models, setModels] = useState<RegisteredModel[]>();
  const [favorites, setFavorites] = useState<string[]>([]);
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    void Promise.all([
      listRegisteredModels(),
      fetch("/api/models/favorites").then(readJson<ModelFavoritesResponse>),
    ])
      .then(([registered, preferences]) => { if (current) {
        setModels(registered);
        setFavorites(preferences.models);
      } })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { current = false; };
  }, []);
  async function toggleFavorite(id: string) {
    if (saving) return;
    setSaving(id);
    setError(undefined);
    try {
      const result = await readJson<ModelFavoritesResponse>(await fetch("/api/models/favorites", {
        method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ model: id, favorite: !favorites.includes(id) }),
      }));
      setFavorites(result.models);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("models.favoriteSaveFailed"));
    } finally {
      setSaving(undefined);
    }
  }
  return <Stack gap="lg">
    <PageHeader title={t("nav.models")} description={t("modelAdmin.onlySelected")} Icon={IconCpu} />
    {error && <Alert color="red">{error}</Alert>}
    {!models && !error && <LoadingText />}
    {models && <ModelCollection scope="browse" models={models} emptyText={t("models.empty")}
      renderActions={model => <Button size="compact-sm" variant={favorites.includes(model.id) ? "light" : "default"}
        leftSection={favorites.includes(model.id) ? <IconStarFilled size={14} /> : <IconStar size={14} />}
        aria-pressed={favorites.includes(model.id)} disabled={!!saving} loading={saving === model.id}
        onClick={() => void toggleFavorite(model.id)}>
        {t(favorites.includes(model.id) ? "models.unfavorite" : "models.favorite")}
      </Button>} />}
  </Stack>;
}
