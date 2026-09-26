"use client";

import { useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Stack } from "@mantine/core";
import { IconCpu, IconStar } from "@tabler/icons-react";
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
  const [favorites, setFavorites] = useState<string[]>();
  const [savingIds, setSavingIds] = useState<string[]>([]);
  const pendingIds = useRef(new Set<string>());
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string>();
  const [favoriteError, setFavoriteError] = useState<string>();
  useEffect(() => {
    let current = true;
    void listRegisteredModels()
      .then(registered => { if (current) setModels(registered); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    void fetch("/api/models/favorites").then(readJson<ModelFavoritesResponse>)
      .then(preferences => { if (current) setFavorites(preferences.models); })
      .catch(error => { if (current) setFavoriteError(error instanceof Error ? error.message : t("models.favoriteLoadFailed")); });
    return () => { current = false; };
  }, [t]);
  function toggleFavorite(id: string) {
    if (favorites === undefined || pendingIds.current.has(id)) return;
    const favorite = !favorites.includes(id);
    pendingIds.current.add(id);
    setSavingIds(current => [...current, id]);
    setFavoriteError(undefined);
    // Serial requests keep each full persisted response authoritative, including
    // other tabs' changes, while only the clicked stars show pending state.
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const result = await readJson<ModelFavoritesResponse>(await fetch("/api/models/favorites", {
          method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ model: id, favorite }),
        }));
        setFavorites(result.models);
      } catch (error) {
        setFavoriteError(error instanceof Error ? error.message : t("models.favoriteSaveFailed"));
      } finally {
        pendingIds.current.delete(id);
        setSavingIds(current => current.filter(model => model !== id));
      }
    });
  }
  return <Stack gap="lg">
    <PageHeader title={t("nav.models")} description={t("modelAdmin.onlySelected")} Icon={IconCpu} />
    {error && <Alert color="red">{error}</Alert>}
    {favoriteError && <Alert color="red">{favoriteError}</Alert>}
    {!models && !error && <LoadingText />}
    {models && <ModelCollection scope="browse" models={models} emptyText={t("models.empty")}
      renderTitleAction={favorites === undefined ? undefined : model => {
        const favorite = favorites.includes(model.id);
        const saving = savingIds.includes(model.id);
        const label = t(favorite ? "models.unfavorite" : "models.favorite");
        return <ActionIcon size="lg" variant="transparent" color="gray"
          aria-label={label} title={label} aria-pressed={favorite} disabled={saving} loading={saving}
          onClick={() => void toggleFavorite(model.id)}>
          <IconStar size={19} fill={favorite ? "var(--mantine-color-yellow-2)" : "none"}
            color={favorite ? "var(--mantine-color-yellow-7)" : undefined} />
        </ActionIcon>;
      }} />}
  </Stack>;
}
