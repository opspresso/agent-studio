"use client";

import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCpu } from "@tabler/icons-react";
import type { ModelConfig } from "@/domain/llm/models";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { BADGE } from "@/app/_components/badgeColors";
import { formatUsd } from "@/app/_lib/formatUsd";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";

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

function priceLabel(pricing: ModelConfig["pricing"]): string {
  if (pricing.perImage !== undefined) {
    return `${formatUsd(pricing.perImage)} / image`;
  }
  return `${formatUsd(pricing.inputPer1M)} in · ${formatUsd(pricing.outputPer1M)} out per 1M`;
}

export default function ModelsPage() {
  const viewer = useViewer();
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [source, setSource] = useState<"override" | "default">("default");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

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
  if (!viewer.isAdmin) return <Alert color="gray">Models are available to admins only.</Alert>;

  return (
    <Stack gap="lg">
      <PageHeader
        title="Models"
        description="Which LLM providers this deployment reaches, and which models users may pick for their agents."
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
          <Group gap="xs">
            {providers.map((provider) => (
              <Badge
                key={provider.name}
                color={provider.available ? BADGE.on : BADGE.attention}
                variant="light"
              >
                {provider.name} ·{" "}
                {provider.dedicated
                  ? "dedicated channel"
                  : provider.available
                    ? "default channel"
                    : "unavailable"}
              </Badge>
            ))}
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

          {providers
            .map((provider) => ({
              provider,
              rows: models.filter((model) => model.provider === provider.name),
            }))
            .filter(({ rows }) => rows.length > 0)
            .map(({ provider, rows }) => (
              <Card key={provider.name}>
                <Group gap="sm" mb="sm">
                  <Text fw={600}>{provider.name}</Text>
                  {!provider.available && (
                    <Badge color={BADGE.attention}>
                      no channel — models here are never offered
                    </Badge>
                  )}
                </Group>
                <Table.ScrollContainer minWidth={860}>
                  <Table highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Model</Table.Th>
                        {CAPABILITY_COLUMNS.map(([key, label]) => (
                          <Table.Th key={key} ta="center">
                            {label}
                          </Table.Th>
                        ))}
                        <Table.Th>Pricing</Table.Th>
                        <Table.Th>Enabled</Table.Th>
                        <Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {rows.map((model) => (
                        <Table.Tr key={model.id}>
                          <Table.Td>
                            <Text fz="sm" fw={500}>
                              {model.displayName}
                            </Text>
                            <Text fz="xs" c="dimmed" ff="monospace">
                              {model.id}
                            </Text>
                          </Table.Td>
                          {CAPABILITY_COLUMNS.map(([key]) => (
                            <Table.Td key={key} ta="center">
                              {model.capabilities[key] ? (
                                <IconCheck
                                  size={16}
                                  color="var(--mantine-color-teal-6)"
                                  aria-label="yes"
                                />
                              ) : (
                                <Text fz="sm" c="dimmed" component="span" aria-label="no">
                                  -
                                </Text>
                              )}
                            </Table.Td>
                          ))}
                          <Table.Td>
                            <Text fz="sm">{priceLabel(model.pricing)}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Switch
                              checked={model.enabled}
                              disabled={busy}
                              aria-label={`Enable ${model.id}`}
                              onChange={(event) =>
                                toggleModel(model.id, event.currentTarget.checked)
                              }
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
                                  <Badge color={BADGE.on}>
                                    {tests[model.id]?.result?.latencyMs} ms
                                  </Badge>
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
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Card>
            ))}
        </>
      )}
    </Stack>
  );
}
