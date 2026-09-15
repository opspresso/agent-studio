"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Card, Group, Loader, Select, Stack, TagsInput, Text, NumberInput, Textarea, Title } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import type { WorkspacePolicyResponse } from "@/app/api/projects/[name]/workspace-policy/route";
import type { WorkspaceRuntime, WorkspaceCheck } from "@/domain/workspace/types";
import Link from "next/link";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { WORKSPACE_REPOSITORY_MODES, workspaceRepositoryMode, type WorkspaceRepositoryMode } from "@/domain/workspace/policy";

export function WorkspaceRepositoryPolicySection({ projectName }: { projectName: string }) {
  const t = useT();
  const [view, setView] = useState<WorkspacePolicyResponse | null>(null);
  const [runtime, setRuntime] = useState<WorkspaceRuntime>("command");
  const [idleTtl, setIdleTtl] = useState<number | string>(1800);
  const [checks, setChecks] = useState<Partial<Record<WorkspaceCheck["name"], string>>>({});
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [mode, setMode] = useState<WorkspaceRepositoryMode>("new");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const endpoint = `/api/projects/${encodeURIComponent(projectName)}/workspace-policy`;

  function apply(next: WorkspacePolicyResponse) {
    setView(next); setRuntime(next.rules.defaultRuntime ?? "command");
    setIdleTtl(next.rules.idleTtlSeconds ?? 1800); setChecks(Object.fromEntries((next.rules.checks ?? []).map(check => [check.name, check.command])));
    setWorkflows(next.rules.deploymentWorkflows ?? []);
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
  async function save() {
    if (!view?.canManage || !view.enabled || busy) return;
    setBusy(true); setSaved(false); setError(null);
    try {
      const next = await readJson<WorkspacePolicyResponse>(await fetch(endpoint, { method: "PUT", headers: jsonHeaders,
        body: JSON.stringify({ revision: view.revision, rules: {
          mode, repositories, repositoryOwners: owners, defaultRuntime: runtime, idleTtlSeconds: Number(idleTtl),
          checks: Object.entries(checks).filter(([, command]) => command?.trim()).map(([name, command]) => ({ name, command })), deploymentWorkflows: workflows,
        } }) }));
      apply(next); setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : "Workspace policy could not be saved"); }
    finally { setBusy(false); }
  }

  return <Card component="section" id="workspace-repositories" style={{ scrollMarginTop: 80 }}>
    <Stack gap="md">
      <Title order={3} size="h5">{t("workspace.toolsTitle")}</Title>
      <Text size="sm" c="dimmed">{t("workspace.policy.description")}</Text>
      {error && <Alert color="red">{error}</Alert>}
      {!view && !error && <Loader size="sm" />}
      {view && !view.backendReady && <Alert>{t("workspace.backendUnavailable")}</Alert>}
      {view && !view.canManage && <Alert>{t("workspace.policy.adminOnly")}</Alert>}
      {view?.enabled && <>
        <Select label={t("workspace.defaultRuntime")} value={runtime} allowDeselect={false} disabled={busy || !view.canManage}
          data={[...new Set([...view.runtimes, runtime])].map(value => ({ value, label: value === "command" ? t("workspace.command") : value, disabled: !view.runtimes.includes(value) }))}
          onChange={value => { if (value) setRuntime(value as WorkspaceRuntime); setSaved(false); }} />
        <Text size="sm" component={Link} href="/models">{t("workspace.runtimeModelsLink")}</Text>
        <Select label={t("workspace.policy.mode")} value={mode} allowDeselect={false} disabled={busy || !view.canManage}
          data={WORKSPACE_REPOSITORY_MODES.map(value => ({ value, label: t(`workspace.policy.mode.${value}`) }))}
          onChange={value => { if (value) setMode(value as WorkspaceRepositoryMode); setSaved(false); }} />
        <Alert variant="light">{t(`workspace.policy.modeHint.${mode}`)}</Alert>
        <TagsInput label={t("workspace.policy.repositories")} description={t("workspace.policy.repositoriesHint")} placeholder="owner/repository"
          value={repositories} onChange={value => { setRepositories(value); setSaved(false); }} maxTags={WORKSPACE_LIMITS.policyRepositories} disabled={busy || !view.canManage} />
        {mode === "owners" && <TagsInput label={t("workspace.policy.owners")} description={t("workspace.policy.ownersHint")} placeholder="owner"
          value={owners} onChange={value => { setOwners(value); setSaved(false); }} maxTags={WORKSPACE_LIMITS.policyOwners} disabled={busy || !view.canManage} />}
        <NumberInput label={t("workspace.idleTtl")} value={idleTtl} min={WORKSPACE_LIMITS.minIdleTtlSeconds} max={WORKSPACE_LIMITS.maxIdleTtlSeconds}
          onChange={value => { setIdleTtl(value); setSaved(false); }} disabled={busy || !view.canManage} allowDecimal={false} />
        {(["test", "lint", "build"] as const).map(name => <Textarea key={name} label={t("workspace.checkCommand", { name })}
          value={checks[name] ?? ""} onChange={event => { const command = event.currentTarget.value; setChecks(current => ({ ...current, [name]: command })); setSaved(false); }} disabled={busy || !view.canManage} />)}
        <TagsInput label={t("workspace.deploymentWorkflows")} value={workflows} onChange={value => { setWorkflows(value); setSaved(false); }} maxTags={20} disabled={busy || !view.canManage} />
        <Text size="sm" c="dimmed">{t("workspace.policy.scopeHint")}</Text>
        {view.canManage && <Group>
          <Button onClick={() => { void save(); }} loading={busy}>{t("workspace.policy.save")}</Button>
          {saved && <Text size="sm" c="teal">{t("workspace.policy.saved")}</Text>}
        </Group>}
      </>}
    </Stack>
  </Card>;
}
