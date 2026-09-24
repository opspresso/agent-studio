"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Group, NumberInput, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { useConfirm } from "@/app/_components/useConfirm";
import { ModelSelect } from "@/app/_components/modelOptions";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { reportError } from "@/app/_lib/reportError";
import { selectableRetrievalModels } from "./modelTable";
import type { ModelsCatalogResponse } from "@/app/api/models/catalog/route";

type Catalog = ModelsCatalogResponse;
type CatalogModel = Catalog["models"][number];
type GlobalModelType = "embedding" | "rerank";

export function ModelSelectionSection({
  models,
  selections,
  rerankerMinScore,
  catalogMinScore,
  available,
  onChanged,
}: {
  models: CatalogModel[];
  selections: Catalog["selections"];
  rerankerMinScore: Catalog["rerankerMinScore"];
  catalogMinScore: Catalog["catalogMinScore"];
  available: Catalog["selectionAvailable"];
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const { confirm, confirmModal } = useConfirm();
  const [busy, setBusy] = useState<GlobalModelType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [rerankerScoreFloor, setRerankerScoreFloor] = useState<number | string>(rerankerMinScore.value);
  const [embeddingScoreFloor, setEmbeddingScoreFloor] = useState<number | string>(catalogMinScore.value);

  useEffect(() => {
    setRerankerScoreFloor(rerankerMinScore.value);
    setEmbeddingScoreFloor(catalogMinScore.value);
  }, [rerankerMinScore.value, catalogMinScore.value]);
  const scoreFloorValid = (value: number | string): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

  async function select(type: GlobalModelType, model: string | null, nextScore?: number) {
    const scoreChanged = nextScore !== undefined && nextScore !== (type === "rerank" ? rerankerMinScore.value : catalogMinScore.value);
    if (!model || (model === selections[type]?.model && !scoreChanged)) return;
    if (
      type === "embedding" &&
      model !== selections.embedding?.model &&
      !(await confirm({
        title: t("models.selection.embeddingConfirmTitle"),
        message: t("models.selection.embeddingConfirmMessage"),
        confirmLabel: t("models.selection.migrate"),
        requireText: "MIGRATE",
        color: "orange",
      }))
    ) {
      return;
    }
    setBusy(type);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/models/selection", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({
          type,
          model,
          migrate: type === "embedding" && model !== selections.embedding?.model,
          ...(type === "rerank" ? { rerankerMinScore: nextScore } : {}),
          ...(type === "embedding" ? { catalogMinScore: nextScore } : {}),
        }),
      });
      const body = await readJson<{ migration?: { indexed: number } }>(response);
      setResult(
        body.migration
          ? t("models.selection.migrated", { count: body.migration.indexed })
          : t("models.selection.saved"),
      );
      await onChanged();
    } catch (selectionError) {
      setError(reportError(selectionError, t("models.selection.failed")));
    } finally {
      setBusy(null);
    }
  }

  return (
    <CollapsibleSection title={t("models.selection.title")}>
      {confirmModal}
      <Stack gap="sm">
        <div>
          <Text fz="sm" c="dimmed">
            {t("models.selection.lede")}
          </Text>
        </div>
        {error && <Alert color="red">{error}</Alert>}
        {result && <Alert color="green">{result}</Alert>}
        {(["embedding", "rerank"] as const).map((type) => {
          const selection = selections[type];
          const options = selectableRetrievalModels(models, type);
          const selected = options.find((model) => model.id === selection?.model);
          const floor = type === "embedding" ? embeddingScoreFloor : rerankerScoreFloor;
          const configuredFloor = type === "embedding" ? catalogMinScore : rerankerMinScore;
          return (
            <Stack key={type} gap="xs">
              <ModelSelect
                label={t(`models.type.${type}`)}
                value={selection?.model ?? null}
                placeholder={t("models.selection.unconfigured")}
                models={options}
                leading={
                  selection?.model && !selected
                    ? [{ value: selection.model, label: selection.model }]
                    : []
                }
                details={selection ? t(`settings.source.${selection.source}`) : undefined}
                disabled={
                  !available[type] ||
                  options.length === 0 ||
                  busy !== null ||
                  !scoreFloorValid(floor)
                }
                searchable
                onChange={(model) =>
                  void select(type, model, scoreFloorValid(floor) ? floor : undefined)
                }
              />
              <Group gap="sm" align="flex-end">
                <NumberInput
                  label={t(type === "embedding" ? "models.selection.catalogMinScore" : "models.selection.rerankerMinScore")}
                  description={`${t(`settings.source.${configuredFloor.source}`)} · ${t(type === "embedding" ? "models.selection.catalogMinScoreHint" : "models.selection.rerankerMinScoreHint")}`}
                  value={floor}
                  min={0}
                  max={1}
                  step={0.01}
                  decimalScale={4}
                  onChange={type === "embedding" ? setEmbeddingScoreFloor : setRerankerScoreFloor}
                  disabled={!available[type] || busy !== null}
                  w={360}
                />
                <Button variant="default" disabled={!available[type] || !selection?.model || !scoreFloorValid(floor) || floor === configuredFloor.value || busy !== null}
                  onClick={() => void select(type, selection?.model ?? null, scoreFloorValid(floor) ? floor : undefined)}>
                  {t("models.selection.saveScore")}
                </Button>
              </Group>
            </Stack>
          );
        })}
      </Stack>
    </CollapsibleSection>
  );
}
