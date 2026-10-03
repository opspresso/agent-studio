"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, FileButton, Group, Stack, Text } from "@mantine/core";
import { IconArrowRight, IconPackage } from "@tabler/icons-react";
import { PluginSyncSummary } from "@/app/_components/PluginSyncSummary";
import { CatalogCollection } from "@/app/_components/CatalogCollection";
import { CatalogViewToggle, useCatalogView } from "@/app/_components/CatalogView";
import rows from "@/app/_components/CatalogRows.module.css";
import { CatalogHelp } from "@/app/_components/CatalogHelp";
import { PageHeader } from "@/app/_components/PageHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useViewer } from "@/app/_lib/useViewer";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDate, formatDateTime } from "@/shared/date";
import {
  getPluginsSyncConfig,
  listPlugins,
  syncPlugins,
  uploadPluginsArchive,
  type Plugin,
  type PluginsSyncConfigResponse,
  type PluginSyncResult,
  type PluginSyncSelection,
} from "./api";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function PluginsPage() {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useCatalogView();
  const viewer = useViewer();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncInFlight = useRef(false);
  const [syncResult, setSyncResult] = useState<PluginSyncResult | null>(null);
  const [syncConfig, setSyncConfig] = useState<PluginsSyncConfigResponse | null>(null);
  /**
   * The archive behind the report on screen, when there is one. Applying a
   * deletion re-runs the sync that reported the orphan, and an archive sync
   * has nothing to re-read but the file — so it stays until the next press of
   * either button decides what the next report comes from.
   */
  const [archive, setArchive] = useState<File | null>(null);
  const resetFilePicker = useRef<() => void>(null);
  const [filter, setFilter] = useState("");
  const latestOnly = useRef(createLatestOnly()).current;

  async function runSync(selection: PluginSyncSelection = {}, source: File | null = archive) {
    if (syncInFlight.current) throw new Error("A plugin sync is already in progress");
    syncInFlight.current = true;
    setSyncing(true);
    try {
      setSyncResult(await (source ? uploadPluginsArchive(source, selection) : syncPlugins(selection)));
      await refresh();
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }

  async function syncFrom(source: File | null) {
    if (syncInFlight.current) return;
    setSyncResult(null);
    setError(null);
    setArchive(source);
    try {
      await runSync({}, source);
    } catch (e) {
      setError(reportError(e, source ? t("plugins.uploadFailed") : "Sync failed"));
    }
  }

  async function refresh() {
    const isCurrent = latestOnly();
    setLoading(true);
    setError(null);
    try {
      const [nextPlugins, config] = await Promise.all([listPlugins(), getPluginsSyncConfig()]);
      if (isCurrent()) {
        setPlugins(nextPlugins);
        setSyncConfig(config);
      }
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "Failed to load plugins");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const visibleItems = plugins.filter((plugin) =>
    matchesFilter(filter, plugin.name, plugin.description),
  );

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.plugins")}
        description={t("plugins.lede")}
        Icon={IconPackage}
      >
        {viewer?.isAdmin && (
          <Group gap="xs">
            <FileButton
              resetRef={resetFilePicker}
              accept=".tar.gz,.tgz,.tar,application/gzip,application/x-gzip,application/x-tar"
              onChange={(file) => {
                resetFilePicker.current?.();
                if (file) {
                  void syncFrom(file);
                }
              }}
            >
              {(props) => (
                <Button
                  {...props}
                  variant="default"
                  loading={syncing && archive !== null}
                  disabled={syncing}
                  title={t("plugins.uploadArchiveHint")}
                >
                  {t("plugins.uploadArchive")}
                </Button>
              )}
            </FileButton>
            <Button
              variant="default"
              loading={syncing && archive === null}
              disabled={syncing || !syncConfig?.configured}
              onClick={() => void syncFrom(null)}
            >
              {t("plugins.syncFromGitHub")}
            </Button>
          </Group>
        )}
      </PageHeader>

      <CatalogHelp title={t("plugins.descriptionTitle")}>{t("plugins.descriptionRole")}</CatalogHelp>

      {syncConfig && (
        <Text fz="xs" c={syncConfig.configured ? "dimmed" : "orange"}>
          {syncConfig.configured && syncConfig.repo
            ? t("plugins.source", { repo: syncConfig.repo, branch: syncConfig.branch })
            : t("plugins.syncNotConfigured")}
          {syncConfig.last &&
            ` · ${t("plugins.lastSynced", { date: formatDateTime(syncConfig.last.finishedAt, locale), actor: syncConfig.last.actorEmail })}`}
          {archive && syncResult && ` · ${t("plugins.archiveSource", { name: archive.name })}`}
        </Text>
      )}

      {/* Show only this page's current action report; the caption dates the persisted last sync. */}
      {syncResult && <PluginSyncSummary result={syncResult} onApply={runSync} busy={syncing} />}

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {plugins.length > 0 && (
        <Group align="flex-start" justify="space-between" gap="md">
          <CatalogSearch value={filter} onChange={setFilter} placeholder={t("plugins.filter")}
            resultCount={visibleItems.length} totalCount={plugins.length}
            onReset={filter ? () => setFilter("") : undefined} />
          <CatalogViewToggle value={view} onChange={setView} />
        </Group>
      )}

      <CatalogCollection view={view} loading={loading} failed={!!error && plugins.length === 0}
        empty={visibleItems.length === 0} emptyText={t(plugins.length === 0 ? "plugins.empty" : "catalog.noResults")}>
          {visibleItems.map((plugin) => (
            <Link key={plugin.name} href={`/plugins/${plugin.name}`} className={rows.row}>
              <div className={rows.identity}>
                <Group gap="xs" wrap="wrap">
                  <Text className={rows.name}>{plugin.name}</Text>
                  {plugin.version && <Badge size="xs" color="gray">v{plugin.version}</Badge>}
                </Group>
              </div>
              <Text className={rows.description} lineClamp={2}>{plugin.description}</Text>
              <div className={rows.meta}>
                <Text fz="xs">{t("plugins.componentCount", { skills: plugin.skills.length, servers: plugin.mcpServers.length })}</Text>
                <Text fz="xs" c="dimmed">{t("plugins.revision", { date: formatDate(plugin.syncedAt, locale), sha: plugin.commitSha.slice(0, 7) })}</Text>
              </div>
              <IconArrowRight className={rows.arrow} size={18} aria-hidden="true" />
            </Link>
          ))}
      </CatalogCollection>
    </Stack>
  );
}
