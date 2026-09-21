"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Group, NumberInput, Select, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { useConfirm } from "@/app/_components/useConfirm";
import { modelSelectData, modelPriceLabel, renderModelOption, selectOnFocus } from "@/app/_components/modelOptions";
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
  available,
  onChanged,
}: {
  models: CatalogModel[];
  selections: Catalog["selections"];
  rerankerMinScore: Catalog["rerankerMinScore"];
  available: Catalog["selectionAvailable"];
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const { confirm, confirmModal } = useConfirm();
  const [busy, setBusy] = useState<GlobalModelType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [scoreFloor, setScoreFloor] = useState(rerankerMinScore.value);

  useEffect(() => {
    setScoreFloor(rerankerMinScore.value);
  }, [rerankerMinScore.value]);
  const scoreFloorValid =
    Number.isFinite(scoreFloor) && scoreFloor >= 0 && scoreFloor <= 1;

  async function select(type: GlobalModelType, model: string | null, nextScore?: number) {
    const scoreChanged = type === "rerank" && nextScore !== rerankerMinScore.value;
    if (!model || (model === selections[type]?.model && !scoreChanged)) return;
    if (
      type === "embedding" &&
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
          migrate: type === "embedding",
          ...(type === "rerank" ? { rerankerMinScore: nextScore } : {}),
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
          return (
            <Stack key={type} gap="xs">
              <Select
                label={t(`models.type.${type}`)}
                value={selection?.model ?? null}
                placeholder={t("models.selection.unconfigured")}
                data={modelSelectData(
                  options,
                  selection?.model && !selected
                    ? [{ value: selection.model, label: selection.model }]
                    : [],
                  t("models.favorites"),
                )}
                renderOption={renderModelOption(options)}
                description={
                  selected
                    ? `${selected.provider} · ${modelPriceLabel(
                        selected.pricingKnown === false ? undefined : selected.pricing,
                        selected.type,
                      )} · ${selection?.source}`
                    : selection?.source
                }
                disabled={
                  !available[type] ||
                  options.length === 0 ||
                  busy !== null ||
                  (type === "rerank" && !scoreFloorValid)
                }
                searchable
                {...selectOnFocus}
                onChange={(model) =>
                  void select(type, model, type === "rerank" ? scoreFloor : undefined)
                }
              />
              {type === "rerank" && (
                <Group gap="sm" align="flex-end">
                  <NumberInput
                    label={t("models.selection.rerankerMinScore")}
                    description={`${rerankerMinScore.source} · ${t("models.selection.rerankerMinScoreHint")}`}
                    value={scoreFloor}
                    min={0}
                    max={1}
                    step={0.01}
                    decimalScale={4}
                    onChange={(value) => setScoreFloor(Number(value))}
                    disabled={!available.rerank || busy !== null}
                    w={360}
                  />
                  <Button
                    variant="default"
                    disabled={
                      !available.rerank ||
                      !selection?.model ||
                      !scoreFloorValid ||
                      scoreFloor === rerankerMinScore.value ||
                      busy !== null
                    }
                    onClick={() => void select("rerank", selection?.model ?? null, scoreFloor)}
                  >
                    {t("models.selection.saveScore")}
                  </Button>
                </Group>
              )}
            </Stack>
          );
        })}
      </Stack>
    </CollapsibleSection>
  );
}
