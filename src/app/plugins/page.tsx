"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { IconPackage } from "@tabler/icons-react";
import { PluginSyncSummary } from "@/app/_components/PluginSyncSummary";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useViewer } from "@/app/_lib/useViewer";
import {
  getPluginsSyncConfig,
  listPlugins,
  syncPlugins,
  type Plugin,
  type PluginsSyncConfig,
  type PluginSyncResult,
  type PluginSyncSelection,
} from "./api";

/**
 * Whether a persisted report is worth a permanent banner. A clean sync —
 * nothing created, changed, removed, orphaned or skipped — says only "the
 * repo and the registry agree", which the "last synced" caption already
 * covers; with the scheduler ticking every minute, rendering it forever made
 * "Imported 0 · unchanged N" the page's most prominent element. Orphans and
 * skips reappear in every report until resolved, so hiding a clean one loses
 * nothing.
 */
function noteworthy(report: PluginSyncResult): boolean {
  return (
    report.skipped.length > 0 ||
    report.orphanedPlugins.length > 0 ||
    report.removedPlugins.length > 0 ||
    report.plugins.some((section) =>
      [section.skills, section.mcpServers].some(
        (kind) =>
          kind.created.length > 0 ||
          kind.overwritten.length > 0 ||
          kind.removed.length > 0 ||
          kind.orphaned.length > 0 ||
          kind.skipped.length > 0,
      ),
    )
  );
}

export default function PluginsPage() {
  const viewer = useViewer();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<PluginSyncResult | null>(null);
  const [syncConfig, setSyncConfig] = useState<PluginsSyncConfig | null>(null);
  const [filter, setFilter] = useState("");

  async function runSync(selection: PluginSyncSelection = {}) {
    setSyncResult(await syncPlugins(selection));
    await refresh();
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextPlugins, config] = await Promise.all([listPlugins(), getPluginsSyncConfig()]);
      setPlugins(nextPlugins);
      setSyncConfig(config);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plugins");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Stack gap="lg">
      <CatalogHeader
        title="Plugins"
        description="Agent Plugins packages synced from GitHub — each bundles skills and MCP servers."
        Icon={IconPackage}
      >
        {viewer?.isAdmin && (
          <Button
            variant="default"
            loading={syncing}
            disabled={!syncConfig?.configured}
            onClick={async () => {
              setSyncing(true);
              setSyncResult(null);
              setError(null);
              try {
                await runSync();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Sync failed");
              } finally {
                setSyncing(false);
              }
            }}
          >
            Sync from GitHub
          </Button>
        )}
      </CatalogHeader>

      {syncConfig && (
        <Text fz="xs" c={syncConfig.configured ? "dimmed" : "orange"}>
          {syncConfig.configured
            ? `GitHub source: ${syncConfig.repo} · ${syncConfig.branch}`
            : "Plugin sync is not configured. Add the repository and token in Settings."}
          {syncConfig.last &&
            ` · last synced ${new Date(syncConfig.last.finishedAt).toLocaleString()} by ${syncConfig.last.actorEmail}`}
        </Text>
      )}

      {/* A fresh result always shows — the operator just asked for it. The
          persisted one returns only while it has something to look at. */}
      {syncResult ? (
        <PluginSyncSummary result={syncResult} onApply={runSync} />
      ) : syncConfig?.last && noteworthy(syncConfig.last.report) ? (
        <PluginSyncSummary result={syncConfig.last.report} onApply={runSync} />
      ) : null}

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {plugins.length > 0 && (
        <CatalogSearch value={filter} onChange={setFilter} placeholder="Filter plugins…" />
      )}

      <CardGrid
        loading={loading}
        empty={plugins.length === 0}
        emptyText="No plugins installed. Configure PLUGINS_REPO in Settings and sync."
      >
        {plugins
          .filter((plugin) => matchesFilter(filter, plugin.name, plugin.description))
          .map((plugin) => (
            <Card key={plugin.name} component={Link} href={`/plugins/${plugin.name}`} h="100%">
              <Group gap="xs" wrap="nowrap">
                <Text fw={500} truncate>
                  {plugin.name}
                </Text>
                {plugin.version && (
                  <Badge size="xs" variant="light">
                    v{plugin.version}
                  </Badge>
                )}
              </Group>
              {plugin.description && (
                <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
                  {plugin.description}
                </Text>
              )}
              <Text fz="xs" c="dimmed" mt={8}>
                {plugin.skills.length} skill{plugin.skills.length === 1 ? "" : "s"} ·{" "}
                {plugin.mcpServers.length} server{plugin.mcpServers.length === 1 ? "" : "s"} ·
                synced {new Date(plugin.syncedAt).toLocaleDateString()} · {plugin.commitSha.slice(0, 7)}
              </Text>
            </Card>
          ))}
      </CardGrid>
    </Stack>
  );
}
