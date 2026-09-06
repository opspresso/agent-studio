"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, FileButton, Group, Stack, Text } from "@mantine/core";
import { IconPackage } from "@tabler/icons-react";
import { PluginSyncSummary } from "@/app/_components/PluginSyncSummary";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
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
  type PluginsSyncConfig,
  type PluginSyncResult,
  type PluginSyncSelection,
} from "./api";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function PluginsPage() {
  const t = useT();
  const locale = useLocale();
  const viewer = useViewer();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<PluginSyncResult | null>(null);
  const [syncConfig, setSyncConfig] = useState<PluginsSyncConfig | null>(null);
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
    setSyncResult(await (source ? uploadPluginsArchive(source, selection) : syncPlugins(selection)));
    await refresh();
  }

  async function syncFrom(source: File | null) {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    setArchive(source);
    try {
      await runSync({}, source);
    } catch (e) {
      setError(reportError(e, source ? t("plugins.uploadFailed") : "Sync failed"));
    } finally {
      setSyncing(false);
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

  return (
    <Stack gap="lg">
      <CatalogHeader
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
              Sync from GitHub
            </Button>
          </Group>
        )}
      </CatalogHeader>

      <Alert color="blue" variant="light" title={t("plugins.descriptionTitle")}>
        {t("plugins.descriptionRole")}
      </Alert>

      {syncConfig && (
        <Text fz="xs" c={syncConfig.configured ? "dimmed" : "orange"}>
          {syncConfig.configured
            ? `GitHub source: ${syncConfig.repo} · ${syncConfig.branch}`
            : "Plugin sync is not configured. Add the repository and token in Settings."}
          {syncConfig.last &&
            ` · last synced ${formatDateTime(syncConfig.last.finishedAt, locale)} by ${syncConfig.last.actorEmail}`}
          {archive && syncResult && ` · ${t("plugins.archiveSource", { name: archive.name })}`}
        </Text>
      )}

      {/*
       * The report belongs to the press that produced it. It is the account of
       * an action the operator just took, so it lives as long as they stay on
       * the page and no longer — leaving the page, or coming back to it, is
       * done with it.
       *
       * The persisted report is deliberately *not* replayed here. It reads as a
       * fresh result while being days old, and there is nothing on it to act on
       * that pressing Sync would not show again: the run is cheap, idempotent,
       * and reports the same skips and the same orphans. `syncConfig.last` still
       * dates the last run in the caption above, and `GET /api/plugins/sync`
       * still carries the whole report for anything that wants it.
       */}
      {syncResult && <PluginSyncSummary result={syncResult} onApply={runSync} />}

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {plugins.length > 0 && (
        <CatalogSearch value={filter} onChange={setFilter} placeholder={t("plugins.filter")} />
      )}

      <CardGrid
        loading={loading}
        empty={plugins.length === 0}
        emptyText={t("plugins.empty")}
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
                synced {formatDate(plugin.syncedAt, locale)} · {plugin.commitSha.slice(0, 7)}
              </Text>
            </Card>
          ))}
      </CardGrid>
    </Stack>
  );
}
