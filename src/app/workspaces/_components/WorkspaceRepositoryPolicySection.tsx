"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, Loader, Select, Stack, TagsInput, Text, TextInput, Title } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import type { WorkspacePolicyResponse } from "@/app/api/projects/[name]/workspace-policy/route";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { WORKSPACE_REPOSITORY_MODES, workspaceRepositoryMode, type WorkspaceRepositoryMode } from "@/domain/workspace/policy";

export function WorkspaceRepositoryPolicySection({ projectName }: { projectName: string }) {
  const t = useT();
  const [view, setView] = useState<WorkspacePolicyResponse | null>(null);
  const [repository, setRepository] = useState("");
  const [repositories, setRepositories] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [mode, setMode] = useState<WorkspaceRepositoryMode>("selected");
  const scrolled = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const endpoint = `/api/projects/${encodeURIComponent(projectName)}/workspace-policy`;

  function apply(next: WorkspacePolicyResponse) {
    setView(next); setRepository(next.rules.repository ?? "");
    setMode(workspaceRepositoryMode(next.rules));
    setRepositories(next.rules.repositories ?? []); setOwners(next.rules.repositoryOwners ?? []);
  }
  useEffect(() => {
    let current = true;
    setView(null); setError(null); setSaved(false);
    void fetch(endpoint).then(response => readJson<WorkspacePolicyResponse>(response)).then(next => { if (current) apply(next); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Workspace policy could not be loaded"); });
    return () => { current = false; };
  }, [endpoint]);
  useEffect(() => {
    if (!view || scrolled.current) return;
    scrolled.current = true;
    const target = window.location.hash.slice(1);
    if (target === "workspace-repositories" || target === "workspaces") document.getElementById(target)?.scrollIntoView({ block: "start" });
  }, [view]);

  async function save(reset = false) {
    if (!view?.canManage || !view.enabled || busy) return;
    setBusy(true); setSaved(false); setError(null);
    try {
      const next = await readJson<WorkspacePolicyResponse>(await fetch(endpoint, { method: "PUT", headers: jsonHeaders,
        body: JSON.stringify({ revision: view.revision, rules: reset ? null : {
          mode, ...(repository.trim() ? { repository: repository.trim() } : {}), repositories, repositoryOwners: owners,
        } }) }));
      apply(next); setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : "Workspace policy could not be saved"); }
    finally { setBusy(false); }
  }

  return <Card component="section" id="workspace-repositories" style={{ scrollMarginTop: 80 }}>
    <Stack gap="md">
      <Group justify="space-between"><Title order={3} size="h5">{t("workspace.policy.title")}</Title>
        {view && <Badge variant="light">{t(view.source === "override" ? "workspace.policy.override" : "workspace.policy.deployment")}</Badge>}
      </Group>
      <Text size="sm" c="dimmed">{t("workspace.policy.description")}</Text>
      {error && <Alert color="red">{error}</Alert>}
      {!view && !error && <Loader size="sm" />}
      {view && !view.enabled && <Alert>{t("workspace.notConfigured")}</Alert>}
      {view && !view.canManage && <Alert>{t("workspace.policy.adminOnly")}</Alert>}
      {view?.enabled && <>
        <Select label={t("workspace.policy.mode")} value={mode} allowDeselect={false} disabled={busy || !view.canManage}
          data={WORKSPACE_REPOSITORY_MODES.map(value => ({ value, label: t(`workspace.policy.mode.${value}`) }))}
          onChange={value => { if (value) setMode(value as WorkspaceRepositoryMode); setSaved(false); }} />
        <Alert variant="light">{t(`workspace.policy.modeHint.${mode}`)}</Alert>
        <TextInput label={t("workspace.policy.defaultRepository")} description={t("workspace.policy.defaultHint")} placeholder="owner/repository"
          value={repository} onChange={event => { setRepository(event.currentTarget.value); setSaved(false); }} disabled={busy || !view.canManage} />
        <TagsInput label={t("workspace.policy.repositories")} description={t("workspace.policy.repositoriesHint")} placeholder="owner/repository"
          value={repositories} onChange={value => { setRepositories(value); setSaved(false); }} maxTags={WORKSPACE_LIMITS.policyRepositories} disabled={busy || !view.canManage} />
        {mode === "owners" && <TagsInput label={t("workspace.policy.owners")} description={t("workspace.policy.ownersHint")} placeholder="owner"
          value={owners} onChange={value => { setOwners(value); setSaved(false); }} maxTags={WORKSPACE_LIMITS.policyOwners} disabled={busy || !view.canManage} />}
        <Text size="sm" c="dimmed">{t("workspace.policy.scopeHint")}</Text>
        {view.canManage && <Group>
          <Button onClick={() => { void save(); }} loading={busy}>{t("workspace.policy.save")}</Button>
          <Button variant="default" disabled={busy || view.source !== "override"} onClick={() => { void save(true); }}>{t("workspace.policy.reset")}</Button>
          {saved && <Text size="sm" c="teal">{t("workspace.policy.saved")}</Text>}
        </Group>}
      </>}
    </Stack>
  </Card>;
}
