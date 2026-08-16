"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconCheck, IconChevronDown, IconChevronUp, IconCpu } from "@tabler/icons-react";
import { MODEL_MAKER_LABELS, type ModelConfig } from "@/domain/llm/models";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { BADGE } from "@/app/_components/badgeColors";
import { modelPriceLabel } from "@/app/_components/modelOptions";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";
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

interface Catalog {
  providers: CatalogProvider[];
  models: CatalogModel[];
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
  ["imageInput", "Vision"],
  ["reasoning", "Reasoning"],
  ["imageGeneration", "Image"],
] as const;

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string;
  sortKey: ModelSortKey;
  activeKey: ModelSortKey;
  direction: SortDirection;
  onSort: (key: ModelSortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <Table.Th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <UnstyledButton onClick={() => onSort(sortKey)} aria-label={`Sort by ${label}`}>
        <Group gap={4} wrap="nowrap">
          <Text fz="sm" fw={600}>{label}</Text>
          {active && (direction === "asc"
            ? <IconChevronUp size={14} aria-hidden />
            : <IconChevronDown size={14} aria-hidden />)}
        </Group>
      </UnstyledButton>
    </Table.Th>
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
  const viewer = useViewer();
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [source, setSource] = useState<"override" | "default">("default");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [tableState, setTableState] = useLocalStorage({
    key: "agentdure.models.table-state.v1",
    defaultValue: DEFAULT_MODEL_TABLE_STATE,
    deserialize: deserializeModelTableState,
  });

  const rows = useMemo(
    () => visibleModelRows(models, tableState),
    [models, tableState],
  );
  const providerByName = useMemo(
    () => new Map(providers.map((provider) => [provider.name, provider])),
    [providers],
  );

  function sortBy(nextKey: ModelSortKey) {
    const next = nextSort(tableState.sortKey, tableState.direction, nextKey);
    setTableState((current) => ({ ...current, ...next }));
  }

  useEffect(() => {
    if (!viewer?.isAdmin) return;
    let cancelled = false;
    fetch("/api/models/catalog")
      .then((res) => readJson<Catalog>(res))
      .then((data) => {
        if (cancelled) return;
        setProviders(data.providers);
        setModels(data.models);
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
  }, [viewer?.isAdmin]);

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
  if (!viewer.isAdmin) return <Alert color="gray">{t("admin.adminOnlyModels")}</Alert>;

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.models")}
        description={t("models.lede")}
        Icon={IconCpu}
      />

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <LoadingText />
      ) : (
        <>
          <Group justify="space-between" align="flex-end" wrap="wrap">
            <Group align="flex-end" wrap="wrap">
              <Select
                label="Provider"
                placeholder="All providers"
                data={providers.map((provider) => provider.name)}
                value={tableState.provider}
                onChange={(provider) => setTableState((current) => ({ ...current, provider }))}
                searchable
                clearable
                w={240}
              />
              <Checkbox.Group
                label="Capabilities"
                value={tableState.capabilities}
                onChange={(values) => setTableState((current) => ({
                  ...current,
                  capabilities: values as FilterCapability[],
                }))}
              >
                <Group gap="md" h={36}>
                  {CAPABILITY_COLUMNS.map(([value, label]) => (
                    <Checkbox key={value} value={value} label={label} />
                  ))}
                </Group>
              </Checkbox.Group>
            </Group>
            <Group gap="xs">
              <Text fz="sm" c="dimmed">
                {rows.length} {rows.length === 1 ? "model" : "models"}
              </Text>
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
            </Group>
          </Group>

          <Table.ScrollContainer minWidth={1040}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <SortableHeader
                    label="Provider"
                    sortKey="provider"
                    activeKey={tableState.sortKey}
                    direction={tableState.direction}
                    onSort={sortBy}
                  />
                  <SortableHeader
                    label="Model"
                    sortKey="name"
                    activeKey={tableState.sortKey}
                    direction={tableState.direction}
                    onSort={sortBy}
                  />
                  {CAPABILITY_COLUMNS.map(([key, label]) => (
                    <Table.Th key={key} ta="center">{label}</Table.Th>
                  ))}
                  <SortableHeader
                    label="Pricing"
                    sortKey="price"
                    activeKey={tableState.sortKey}
                    direction={tableState.direction}
                    onSort={sortBy}
                  />
                  <Table.Th>Enabled</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((model) => {
                  const provider = providerByName.get(model.provider);
                  return (
                    <Table.Tr key={model.id}>
                      <Table.Td>
                        <Text fz="sm" fw={500}>{model.provider}</Text>
                        <Badge
                          size="xs"
                          color={provider?.available ? BADGE.on : BADGE.attention}
                          variant="light"
                        >
                          {provider?.dedicated
                            ? "dedicated"
                            : provider?.available
                              ? "default"
                              : "unavailable"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <Tooltip label={MODEL_MAKER_LABELS[model.maker]}>
                            <Box
                              w={32}
                              h={32}
                              p={4}
                              bg="white"
                              style={{ borderRadius: "var(--mantine-radius-sm)", flexShrink: 0 }}
                            >
                              <img
                                src={`/provider-logos/${model.maker}.svg`}
                                alt={`${MODEL_MAKER_LABELS[model.maker]} logo`}
                                width={24}
                                height={24}
                              />
                            </Box>
                          </Tooltip>
                          <div>
                            <Text fz="sm" fw={500}>{model.displayName}</Text>
                            <Text fz="xs" c="dimmed" ff="monospace">{model.id}</Text>
                            {otherRoutes(models, model).length > 0 && (
                              <Text fz="xs" c="dimmed">
                                also via {otherRoutes(models, model).join(", ")}
                              </Text>
                            )}
                          </div>
                        </Group>
                      </Table.Td>
                      {CAPABILITY_COLUMNS.map(([key]) => (
                        <Table.Td key={key} ta="center">
                          {model.capabilities[key] ? (
                            <IconCheck
                              size={16}
                              color="var(--mantine-color-teal-6)"
                              aria-label={t("models.yes")}
                            />
                          ) : (
                            <Text fz="sm" c="dimmed" component="span" aria-label={t("models.no")}>
                              -
                            </Text>
                          )}
                        </Table.Td>
                      ))}
                      <Table.Td>
                        <Text fz="sm">{modelPriceLabel(model.pricing)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Switch
                          checked={model.enabled}
                          disabled={busy}
                          aria-label={`Enable ${model.id}`}
                          onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Button
                            size="compact-xs"
                            variant="default"
                            loading={tests[model.id]?.running}
                            onClick={() => void runTest(model.id)}
                          >
                            Test
                          </Button>
                          {tests[model.id]?.result &&
                            (tests[model.id]?.result?.ok ? (
                              <Badge color={BADGE.on}>{tests[model.id]?.result?.latencyMs} ms</Badge>
                            ) : (
                              <Tooltip
                                label={tests[model.id]?.result?.error ?? "failed"}
                                multiline
                                maw={360}
                              >
                                <Badge color={BADGE.broken}>failed</Badge>
                              </Tooltip>
                            ))}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </>
      )}
    </Stack>
  );
}
