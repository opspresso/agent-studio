"use client";

import { useEffect, useState } from "react";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Group,
  Stack,
  Switch,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconCheck, IconCpu } from "@tabler/icons-react";
import type { ModelConfig } from "@/domain/llm/models";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { BADGE } from "@/app/_components/badgeColors";
import { modelPriceLabel } from "@/app/_components/modelOptions";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";

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

/**
 * The other providers that serve the same model.
 *
 * The cards below are per provider, because that is what an admin configures
 * and what the "no channel" badge is about. But a model reached three ways is
 * one model, and the thing worth seeing next to a price is that the same thing
 * is available elsewhere at a different one — so each row says where else it
 * lives instead of the reader having to spot the name three cards apart.
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
  /**
   * Which provider sections are open, remembered per browser.
   *
   * Closed is the default because the interesting question on arrival is which
   * providers this deployment reaches and whether each has a channel — the
   * badges above answer that — while six open tables of every model push it off
   * the screen. The hook reads storage *after* mount, so the server and the
   * first client render agree; opening one is a per-person habit, not a setting,
   * which is why it lives in the browser and not in the settings row.
   */
  const [openProviders, setOpenProviders] = useLocalStorage<string[]>({
    key: "agentdure.models.open-providers",
    defaultValue: [],
  });

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

          {/*
            * A multi-item accordion rather than the shared `CollapsibleSection`:
            * these open independently and their combined state is what gets
            * remembered, which a per-section component cannot express.
            */}
          <Accordion
            multiple
            variant="separated"
            radius="md"
            chevronPosition="left"
            value={openProviders}
            onChange={setOpenProviders}
          >
            {providers
              .map((provider) => ({
                provider,
                rows: models.filter((model) => model.provider === provider.name),
              }))
              .filter(({ rows }) => rows.length > 0)
              .map(({ provider, rows }) => (
                <Accordion.Item key={provider.name} value={provider.name}>
                  <Accordion.Control>
                    <Group gap="sm" wrap="wrap">
                      <Text fw={600}>{provider.name}</Text>
                      <Text fz="xs" c="dimmed">
                        {rows.length} {rows.length === 1 ? "model" : "models"} ·{" "}
                        {rows.filter((model) => model.enabled).length} enabled
                      </Text>
                      {!provider.available && (
                        <Badge color={BADGE.attention}>
                          no channel — models here are never offered
                        </Badge>
                      )}
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
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
                                {otherRoutes(models, model).length > 0 && (
                                  <Text fz="xs" c="dimmed">
                                    also via {otherRoutes(models, model).join(", ")}
                                  </Text>
                                )}
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
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
          </Accordion>
        </>
      )}
    </Stack>
  );
}
