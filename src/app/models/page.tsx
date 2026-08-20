"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconChevronDown, IconChevronUp, IconCpu } from "@tabler/icons-react";
import { contextWindowLabel, type ModelConfig } from "@/domain/llm/models";
import { formatUsd } from "@/app/_lib/formatUsd";
import { formatDate } from "@/shared/date";
import { tierAtLeast } from "@/domain/member/tiers";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { LoadingText } from "@/app/_components/PageState";
import { BADGE } from "@/app/_components/badgeColors";
import { modelPriceLabel } from "@/app/_components/modelOptions";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { useLocale, useT } from "@/app/_i18n/provider";
import {
  nextSort,
  deserializeModelTableState,
  DEFAULT_MODEL_TABLE_STATE,
  visibleModelRows,
  type ModelSortKey,
  type SortDirection,
  type FilterCapability,
} from "./modelTable";

interface CatalogProvider {
  name: string;
  available: boolean;
  dedicated: boolean;
}

type CatalogModel = ModelConfig & { enabled: boolean };

/** A maker's label, or its id for one the loaded catalog does not name. */
function makerLabel(makers: Record<string, string>, maker: string): string {
  return makers[maker] ?? maker;
}

interface Catalog {
  providers: CatalogProvider[];
  models: CatalogModel[];
  /** Maker id → label, as the loaded catalog names them. */
  makers: Record<string, string>;
  updatedAt: string;
  source: "override" | "default";
}

interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

type TestState = { running: boolean; result?: ModelTestResult };

const CAPABILITY_COLUMNS = [
  ["tools", "Tools"],
  ["structuredOutput", "JSON"],
  ["imageInput", "Vision"],
  ["reasoning", "Reasoning"],
  ["imageGeneration", "Image"],
] as const;

/**
 * The registry's rates with a promotional discount backed out — the list
 * price, in the shape `modelPriceLabel` renders, so the tooltip's collapse of
 * per-1M vs per-image billing is the same one the label beside it uses rather
 * than a third rule.
 */
function undiscounted(pricing: ModelConfig["pricing"], discount: number): ModelConfig["pricing"] {
  const up = (rate: number | undefined) => (rate === undefined ? undefined : rate / (1 - discount));
  return {
    ...pricing,
    inputPer1M: pricing.inputPer1M / (1 - discount),
    outputPer1M: pricing.outputPer1M / (1 - discount),
    imageOutputPer1M: up(pricing.imageOutputPer1M),
    perImage: up(pricing.perImage),
  };
}

/**
 * The one-line price row: the label the registry's rates make, and — where the
 * catalog says the rate is a promotion — how deep it is, with the list price
 * in the tooltip. The badge is informational: cost is computed from the rates
 * as stated, which are already net of the discount. A discount that rounds to
 * 0% shows nothing — a "−0%" badge is noise wearing a number.
 */
function PriceLine({ pricing }: { pricing: ModelConfig["pricing"] }) {
  const t = useT();
  const discount = pricing.discount;
  const percent = discount === undefined ? 0 : Math.round(discount * 100);
  return (
    <Group gap={6} mt="sm" align="center" wrap="wrap">
      <Text fz="sm">{modelPriceLabel(pricing)}</Text>
      {discount !== undefined && percent > 0 && (
        <Tooltip
          multiline
          maw={320}
          label={t("models.promoTooltip", { list: modelPriceLabel(undiscounted(pricing, discount)) })}
        >
          <Badge size="sm" variant="light" color="green">
            −{percent}%
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

/**
 * The sort control, in the shape a card grid can carry: one button per key,
 * the active one showing its direction and flipping it when pressed again —
 * the same rule the table headers followed (`nextSort`), so a preference saved
 * under the old layout still means what it meant.
 */
function SortButtons({
  activeKey,
  direction,
  onSort,
}: {
  activeKey: ModelSortKey;
  direction: SortDirection;
  onSort: (key: ModelSortKey) => void;
}) {
  const keys: Array<[ModelSortKey, string]> = [
    ["provider", "Provider"],
    ["name", "Model"],
    ["price", "Price"],
  ];
  return (
    <Button.Group>
      {keys.map(([key, label]) => {
        const active = key === activeKey;
        return (
          <Button
            key={key}
            size="xs"
            variant={active ? "light" : "default"}
            onClick={() => onSort(key)}
            aria-label={`Sort by ${label}`}
            aria-pressed={active}
            rightSection={
              active ? (
                direction === "asc" ? (
                  <IconChevronUp size={14} aria-hidden />
                ) : (
                  <IconChevronDown size={14} aria-hidden />
                )
              ) : undefined
            }
          >
            {label}
          </Button>
        );
      })}
    </Button.Group>
  );
}

/**
 * The other providers that serve the same model.
 *
 * A model reached three ways is one model, and the thing worth seeing next to
 * a price is that the same thing is available elsewhere at a different one —
 * so each row says where else it lives instead of making the reader compare
 * repeated names manually.
 */
function otherRoutes(models: CatalogModel[], model: CatalogModel): string[] {
  return models
    .filter((other) => other.family === model.family && other.provider !== model.provider)
    .map((other) => other.provider);
}

export default function ModelsPage() {
  const t = useT();
  const locale = useLocale();
  const viewer = useViewer();
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [makers, setMakers] = useState<Record<string, string>>({});
  const [updatedAt, setUpdatedAt] = useState("");
  const [source, setSource] = useState<"override" | "default">("default");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [filter, setFilter] = useState("");
  const [tableState, setTableState] = useLocalStorage({
    key: "agent-studio.models.table-state.v1",
    defaultValue: DEFAULT_MODEL_TABLE_STATE,
    deserialize: deserializeModelTableState,
  });

  const rows = useMemo(
    () =>
      visibleModelRows(models, tableState).filter((model) =>
        matchesFilter(
          filter,
          model.id,
          model.displayName,
          model.provider,
          makerLabel(makers, model.maker),
        ),
      ),
    [models, makers, tableState, filter],
  );
  const providerByName = useMemo(
    () => new Map(providers.map((provider) => [provider.name, provider])),
    [providers],
  );

  function sortBy(nextKey: ModelSortKey) {
    const next = nextSort(tableState.sortKey, tableState.direction, nextKey);
    setTableState((current) => ({ ...current, ...next }));
  }

  const canRead = viewer !== null && tierAtLeast(viewer.tier, "member");
  const canEdit = viewer?.isAdmin === true;

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    fetch("/api/models/catalog")
      .then((res) => readJson<Catalog>(res))
      .then((data) => {
        if (cancelled) return;
        setProviders(data.providers);
        setModels(data.models);
        setMakers(data.makers ?? {});
        setUpdatedAt(data.updatedAt ?? "");
        setSource(data.source);
      })
      .catch(
        (loadError) =>
          !cancelled &&
          setError(loadError instanceof Error ? loadError.message : "Failed to load the catalog"),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  async function saveEnabled(
    enabledIds: string[],
    nextModels: CatalogModel[],
    nextSource: "override" | "default",
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ enabledModels: enabledIds }),
      });
      await readJson(res);
      setModels(nextModels);
      setSource(nextSource);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function toggleModel(id: string, on: boolean) {
    const nextModels = models.map((model) => (model.id === id ? { ...model, enabled: on } : model));
    const enabledIds = nextModels.filter((model) => model.enabled).map((model) => model.id);
    if (enabledIds.length === 0) {
      setError("At least one model must stay enabled.");
      return;
    }
    // Everything on is the same policy as no override — store it as none, so a
    // model added to the registry later is not silently disabled by a stale list.
    const allOn = enabledIds.length === nextModels.length;
    void saveEnabled(allOn ? [] : enabledIds, nextModels, allOn ? "default" : "override");
  }

  async function runTest(id: string) {
    setTests((prev) => ({ ...prev, [id]: { running: true } }));
    let result: ModelTestResult;
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ model: id }),
      });
      result = await readJson<ModelTestResult>(res);
    } catch (testError) {
      result = {
        ok: false,
        latencyMs: 0,
        error: testError instanceof Error ? testError.message : "Test request failed",
      };
    }
    setTests((prev) => ({ ...prev, [id]: { running: false, result } }));
  }

  if (viewer === null) return <LoadingText />;
  if (!canRead) return <Alert color="gray">{t("models.memberOnly")}</Alert>;

  return (
    <Stack gap="lg">
      <CatalogHeader title={t("nav.models")} description={t("models.lede")} Icon={IconCpu}>
        {canEdit && source === "override" && (
          <Group gap="xs">
            <Badge color={BADGE.attention}>selection restricted</Badge>
            <Button
              size="compact-xs"
              variant="default"
              disabled={busy}
              onClick={() =>
                void saveEnabled(
                  [],
                  models.map((model) => ({ ...model, enabled: true })),
                  "default",
                )
              }
            >
              Reset — allow all
            </Button>
          </Group>
        )}
      </CatalogHeader>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {models.length > 0 && (
        <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
          <Group align="flex-end" wrap="wrap" gap="md">
            <CatalogSearch value={filter} onChange={setFilter} placeholder={t("models.filter")} />
            <Select
              aria-label="Provider"
              placeholder="All providers"
              data={providers.map((provider) => provider.name)}
              value={tableState.provider}
              onChange={(provider) => setTableState((current) => ({ ...current, provider }))}
              searchable
              clearable
              w={200}
            />
            <Checkbox.Group
              aria-label="Capabilities"
              value={tableState.capabilities}
              onChange={(values) =>
                setTableState((current) => ({
                  ...current,
                  capabilities: values as FilterCapability[],
                }))
              }
            >
              <Group gap="md" h={36}>
                {CAPABILITY_COLUMNS.map(([value, label]) => (
                  <Checkbox key={value} value={value} label={label} />
                ))}
              </Group>
            </Checkbox.Group>
          </Group>
          <Group gap="sm" align="center">
            <Text fz="sm" c="dimmed">
              {rows.length} {rows.length === 1 ? "model" : "models"}
              {updatedAt && ` · ${t("models.catalogUpdated")} ${formatDate(updatedAt, locale)}`}
            </Text>
            <SortButtons
              activeKey={tableState.sortKey}
              direction={tableState.direction}
              onSort={sortBy}
            />
          </Group>
        </Group>
      )}

      <CardGrid loading={loading} empty={models.length === 0} emptyText={t("models.empty")}>
        {rows.map((model) => {
          const provider = providerByName.get(model.provider);
          const routes = otherRoutes(models, model);
          const test = tests[model.id];
          return (
            <Card key={model.id} h="100%">
              <Stack gap="sm" h="100%" justify="space-between">
                <div>
                  <Group gap="sm" wrap="nowrap" align="flex-start">
                    <Tooltip label={makerLabel(makers, model.maker)}>
                      <Box
                        w={32}
                        h={32}
                        p={4}
                        bg="white"
                        style={{ borderRadius: "var(--mantine-radius-sm)", flexShrink: 0 }}
                      >
                        <img
                          src={`/icons/brands/${model.maker}.svg`}
                          alt={`${makerLabel(makers, model.maker)} logo`}
                          width={24}
                          height={24}
                          // A maker the catalog gained before this checkout got
                          // its mark: show nothing rather than a broken image.
                          onError={(event) => {
                            event.currentTarget.style.visibility = "hidden";
                          }}
                        />
                      </Box>
                    </Tooltip>
                    <div style={{ minWidth: 0 }}>
                      <Text fw={500} truncate>
                        {model.displayName}
                      </Text>
                      <Text fz="xs" c="dimmed" ff="monospace" truncate>
                        {model.id}
                      </Text>
                    </div>
                  </Group>
                  <Group gap={6} mt="sm" wrap="wrap">
                    <Badge
                      size="sm"
                      variant="light"
                      color={provider?.available ? BADGE.on : BADGE.attention}
                    >
                      {model.provider}
                      {provider?.dedicated
                        ? " · dedicated"
                        : provider?.available
                          ? ""
                          : " · unavailable"}
                    </Badge>
                    {CAPABILITY_COLUMNS.filter(([key]) => model.capabilities[key]).map(
                      ([key, label]) =>
                        key === "reasoning" && model.capabilities.reasoningWithTools === false ? (
                          // The provider rejects tools together with reasoning_effort,
                          // so an agent run forces the effort to "none" (applyModelConstraints).
                          <Tooltip key={key} multiline maw={300} label={t("models.reasoningNoTools")}>
                            <Badge size="sm" variant="outline" color="yellow">
                              {label}
                            </Badge>
                          </Tooltip>
                        ) : (
                          <Badge key={key} size="sm" variant="outline" color="gray">
                            {label}
                          </Badge>
                        ),
                    )}
                    {!model.enabled && (
                      <Badge size="sm" variant="light" color={BADGE.attention}>
                        disabled
                      </Badge>
                    )}
                  </Group>
                  <PriceLine pricing={model.pricing} />
                  <Text fz="xs" c="dimmed" mt={2}>
                    {contextWindowLabel(model)}
                    {model.pricing.cachedInputPer1M !== undefined &&
                      !model.capabilities.imageGeneration &&
                      ` · ${t("models.cached")} ${formatUsd(model.pricing.cachedInputPer1M)}`}
                  </Text>
                  {routes.length > 0 && (
                    <Text fz="xs" c="dimmed" mt={4}>
                      also via {routes.join(", ")}
                    </Text>
                  )}
                </div>
                {canEdit && (
                  <Group justify="space-between" align="center" wrap="nowrap">
                    <Switch
                      size="sm"
                      label="Enabled"
                      checked={model.enabled}
                      disabled={busy}
                      aria-label={`Enable ${model.id}`}
                      onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
                    />
                    <Group gap="xs" wrap="nowrap">
                      {test?.result &&
                        (test.result.ok ? (
                          <Badge color={BADGE.on}>{test.result.latencyMs} ms</Badge>
                        ) : (
                          <Tooltip label={test.result.error ?? "failed"} multiline maw={360}>
                            <Badge color={BADGE.broken}>failed</Badge>
                          </Tooltip>
                        ))}
                      <Button
                        size="compact-xs"
                        variant="default"
                        loading={test?.running}
                        onClick={() => void runTest(model.id)}
                      >
                        Test
                      </Button>
                    </Group>
                  </Group>
                )}
              </Stack>
            </Card>
          );
        })}
      </CardGrid>
    </Stack>
  );
}
