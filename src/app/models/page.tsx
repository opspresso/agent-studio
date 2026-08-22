"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconChevronDown, IconChevronUp, IconCpu } from "@tabler/icons-react";
import { contextWindowLabel, type ModelConfig } from "@/domain/llm/models";
import {
  selfHostedModelToInput,
  type SelfHostedModelInput,
} from "@/domain/llm/selfHostedModels";
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
import { reportError } from "@/app/_lib/reportError";

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

/** What the selfhosted channel reports it serves (`GET /api/models/selfhosted`). */
interface ServedModel {
  name: string;
  contextWindow?: number;
  vision?: boolean;
}

/** The section's whole picture, from `GET /api/models/selfhosted`. */
interface SelfHostedView {
  /** Null when the channel did not answer — `servedError` says why. */
  served: ServedModel[] | null;
  servedError?: string;
  /** The stored declarations — the editing basis, installed or not. */
  declarations: ModelConfig[];
  /** Ids the registry actually installed; a stored id missing here was refused. */
  installed: string[];
}

const DECLARABLE_CAPABILITIES = [
  ["tools", "Tools"],
  ["structuredOutput", "JSON"],
  ["imageInput", "Vision"],
  ["reasoning", "Reasoning"],
] as const;

/**
 * The deployment's own models: the stored declarations (the editing basis —
 * one the registry refused to install must still be visible here, or the next
 * full-replace save would delete it silently), what the channel serves, and
 * the gaps in both directions. Declaring is a settings write; when the
 * deployment restricts selection (`enabledIds` non-null) the same write keeps
 * the enabled list in step, so a new declaration is usable at once and a
 * removed one does not leave a stale id that blocks a later resubmission. The
 * serving stack stays the availability judge: the Test button on the model's
 * own card is what proves a run can actually use it.
 */
function SelfHostedSection({
  enabledIds,
  onChanged,
}: {
  /** The enabled-models override as ids, or null when the deployment has none. */
  enabledIds: string[] | null;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [view, setView] = useState<SelfHostedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<SelfHostedModelInput | null>(null);

  const loadView = useCallback(async () => {
    const data = await readJson<SelfHostedView>(await fetch("/api/models/selfhosted"));
    setView(data);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadView().catch(
      (loadError) =>
        !cancelled &&
        setError(loadError instanceof Error ? loadError.message : "Failed to read the channel"),
    );
    return () => {
      cancelled = true;
    };
  }, [loadView]);

  async function save(
    next: SelfHostedModelInput[],
    enabled: { add?: string; drop?: string } = {},
  ) {
    // With a selection override in place, the declaration change carries the
    // matching enabled-list change in the same PUT (the API accepts a
    // same-patch declare-and-enable on purpose).
    let enabledPatch: { enabledModels?: string[] } = {};
    if (enabledIds !== null) {
      let ids = enabled.add ? [...new Set([...enabledIds, enabled.add])] : [...enabledIds];
      if (enabled.drop) {
        ids = ids.filter((id) => id !== enabled.drop);
      }
      // The same guard the page's enable toggles keep: an empty override is
      // not "restrict to nothing" — the server reads it as "remove the
      // restriction", silently opening every model for selection.
      if (ids.length === 0) {
        setError("At least one model must stay enabled.");
        return;
      }
      enabledPatch = { enabledModels: ids };
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ selfHostedModels: next, ...enabledPatch }),
      });
      await readJson(res);
      await Promise.all([onChanged(), loadView()]);
      setForm(null);
    } catch (saveError) {
      setError(reportError(saveError, "Failed to save"));
    } finally {
      setBusy(false);
    }
  }

  const declarations = view?.declarations ?? [];
  const served = view?.served ?? null;
  const installed = new Set(view?.installed ?? []);
  const declaredFamilies = new Set(declarations.map((model) => model.family));
  const undeclared = (served ?? []).filter((row) => !declaredFamilies.has(row.name));

  return (
    <Card withBorder>
      <Stack gap="sm">
        <div>
          <Text fw={600}>{t("models.selfHosted.title")}</Text>
          <Text fz="sm" c="dimmed">
            {t("models.selfHosted.lede")}
          </Text>
        </div>
        {error && (
          <Alert color="orange" variant="light" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {view?.servedError !== undefined && (
          <Text fz="sm" c="orange">
            {view.servedError}
          </Text>
        )}
        {declarations.map((model) => (
          <Group key={model.id} justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap">
              <Text fz="sm" ff="monospace">
                {model.family}
              </Text>
              {!installed.has(model.id) && (
                <Tooltip multiline maw={320} label={t("models.selfHosted.notInstalledHint")}>
                  <Badge size="sm" variant="light" color={BADGE.broken}>
                    {t("models.selfHosted.notInstalled")}
                  </Badge>
                </Tooltip>
              )}
              {served !== null && !served.some((row) => row.name === model.family) && (
                <Tooltip multiline maw={320} label={t("models.selfHosted.notServedHint")}>
                  <Badge size="sm" variant="light" color={BADGE.attention}>
                    {t("models.selfHosted.notServed")}
                  </Badge>
                </Tooltip>
              )}
            </Group>
            <Button
              size="compact-xs"
              variant="default"
              disabled={busy}
              onClick={() =>
                void save(
                  declarations.filter((m) => m.id !== model.id).map(selfHostedModelToInput),
                  { drop: model.id },
                )
              }
            >
              {t("models.selfHosted.remove")}
            </Button>
          </Group>
        ))}
        {undeclared.map((row) => (
          <Group key={row.name} justify="space-between" wrap="nowrap">
            <div>
              <Text fz="sm" ff="monospace">
                {row.name}
              </Text>
              <Text fz="xs" c="dimmed">
                {t("models.selfHosted.servedBy")}
                {row.contextWindow !== undefined && ` · ctx ${row.contextWindow}`}
                {row.vision === true && " · vision"}
              </Text>
            </div>
            <Button
              size="compact-xs"
              variant="light"
              disabled={busy}
              onClick={() =>
                setForm({
                  family: row.name,
                  displayName: row.name.slice(row.name.lastIndexOf("/") + 1),
                  contextWindow: row.contextWindow ?? 32768,
                  maxTokens: Math.min(8192, row.contextWindow ?? 32768),
                  capabilities: {
                    tools: true,
                    structuredOutput: true,
                    imageInput: row.vision === true,
                    reasoning: false,
                  },
                })
              }
            >
              {t("models.selfHosted.declare")}
            </Button>
          </Group>
        ))}
        {served !== null && served.length === 0 && (
          <Text fz="sm" c="dimmed">
            {t("models.selfHosted.empty")}
          </Text>
        )}
        {form && (
          <Card withBorder>
            <Stack gap="xs">
              <Text fz="sm" ff="monospace">
                {form.family}
              </Text>
              <Group gap="md" wrap="wrap" align="flex-end">
                <TextInput
                  size="xs"
                  label={t("models.selfHosted.displayName")}
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.currentTarget.value })}
                  w={220}
                />
                <NumberInput
                  size="xs"
                  label={t("models.selfHosted.context")}
                  value={form.contextWindow}
                  min={1}
                  onChange={(value) => setForm({ ...form, contextWindow: Number(value) || 0 })}
                  w={150}
                />
                <NumberInput
                  size="xs"
                  label={t("models.selfHosted.maxOutput")}
                  value={form.maxTokens}
                  min={1}
                  onChange={(value) => setForm({ ...form, maxTokens: Number(value) || 0 })}
                  w={150}
                />
              </Group>
              <Group gap="md">
                {DECLARABLE_CAPABILITIES.map(([key, label]) => (
                  <Checkbox
                    key={key}
                    size="xs"
                    label={label}
                    checked={form.capabilities[key]}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        capabilities: {
                          ...form.capabilities,
                          [key]: event.currentTarget.checked,
                        } as SelfHostedModelInput["capabilities"],
                      })
                    }
                  />
                ))}
              </Group>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  loading={busy}
                  onClick={() =>
                    void save([...declarations.map(selfHostedModelToInput), form], {
                      add: `selfhosted/${form.family}`,
                    })
                  }
                >
                  {t("models.selfHosted.declare")}
                </Button>
                <Button size="compact-xs" variant="default" disabled={busy} onClick={() => setForm(null)}>
                  {t("models.selfHosted.cancel")}
                </Button>
              </Group>
            </Stack>
          </Card>
        )}
      </Stack>
    </Card>
  );
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
  const [refreshing, setRefreshing] = useState(false);
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

  const loadCatalog = useCallback(async () => {
    const data = await readJson<Catalog>(await fetch("/api/models/catalog"));
    setProviders(data.providers);
    setModels(data.models);
    setMakers(data.makers ?? {});
    setUpdatedAt(data.updatedAt ?? "");
    setSource(data.source);
  }, []);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    loadCatalog()
      .catch(
        (loadError) =>
          !cancelled &&
          setError(loadError instanceof Error ? loadError.message : "Failed to load the catalog"),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [canRead, loadCatalog]);

  /** Pull the published catalog into the registry now, then re-read the view. */
  async function refreshCatalog() {
    setRefreshing(true);
    setError(null);
    try {
      await readJson(await fetch("/api/models/refresh", { method: "POST" }));
      await loadCatalog();
    } catch (refreshError) {
      setError(
        reportError(refreshError, "Failed to refresh the catalog"),
      );
    } finally {
      setRefreshing(false);
    }
  }

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
      setError(reportError(saveError, "Failed to save"));
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
        {canEdit && (
          <Group gap="xs">
            {source === "override" && (
              <>
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
              </>
            )}
            <Button variant="default" loading={refreshing} onClick={() => void refreshCatalog()}>
              {t("models.refreshNow")}
            </Button>
          </Group>
        )}
      </CatalogHeader>

      {canEdit && providerByName.get("selfhosted")?.dedicated === true && (
        <SelfHostedSection
          enabledIds={
            source === "override"
              ? models.filter((model) => model.enabled).map((model) => model.id)
              : null
          }
          onChanged={loadCatalog}
        />
      )}

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
