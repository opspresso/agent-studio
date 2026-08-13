"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Group, Stack, Switch, Table, Text } from "@mantine/core";
import { IconCpu } from "@tabler/icons-react";
import type { ModelConfig } from "@/domain/llm/models";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { BADGE } from "@/app/_components/badgeColors";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { TestModelModal } from "./TestModelModal";

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

const CAPABILITY_LABELS = [
  ["tools", "tools"],
  ["imageInput", "vision"],
  ["reasoning", "reasoning"],
  ["imageGeneration", "image"],
] as const;

export default function ModelsPage() {
  const viewer = useViewer();
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [source, setSource] = useState<"override" | "default">("default");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

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

  if (viewer === null) return <LoadingText />;
  if (!viewer.isAdmin) return <Alert color="gray">Models are available to admins only.</Alert>;

  const testedModel = models.find((model) => model.id === testing);

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
                <Table.ScrollContainer minWidth={720}>
                  <Table highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Model</Table.Th>
                        <Table.Th>Capabilities</Table.Th>
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
                          <Table.Td>
                            <Group gap={4}>
                              {CAPABILITY_LABELS.filter(([key]) => model.capabilities[key]).map(
                                ([key, label]) => (
                                  <Badge key={key} size="sm">
                                    {label}
                                  </Badge>
                                ),
                              )}
                            </Group>
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
                            <Button
                              size="compact-xs"
                              variant="default"
                              onClick={() => setTesting(model.id)}
                            >
                              Test
                            </Button>
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

      <TestModelModal
        model={testedModel?.id ?? null}
        opened={testing !== null}
        onClose={() => setTesting(null)}
      />
    </Stack>
  );
}
