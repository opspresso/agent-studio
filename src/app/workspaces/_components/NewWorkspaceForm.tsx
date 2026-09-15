"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Anchor, Autocomplete, Button, Group, Loader, Select, Stack, Switch, Text, Textarea, ThemeIcon, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconTerminal2 } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { onModEnter } from "@/app/_lib/modEnter";
import { notifyWorkspaceActivity } from "../_lib/activity";
import type { WorkspaceOptionsResponse } from "@/app/api/workspaces/options/route";
import type { WorkspaceBranchesResponse } from "@/app/api/workspaces/branches/route";
import type { StartWorkspaceResponse } from "@/app/api/workspaces/route";
import type { WorkspaceRuntime } from "@/domain/workspace/types";
import { workspaceAllowsRepository } from "@/domain/workspace/policy";

export function NewWorkspaceForm() {
  const t = useT();
  const router = useRouter();
  const [options, setOptions] = useState<WorkspaceOptionsResponse | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<WorkspaceRuntime>("command");
  const [coding, setCoding] = useState(false);
  const [repository, setRepository] = useState<string | null>(null);
  const [branch, setBranch] = useState("main");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ body: string; key: string } | null>(null);
  const selected = options?.projects.find(option => option.projectName === project);
  const [branchRepository] = useDebouncedValue(repository, 300);
  const repositoryAllowed = !!selected && !!repository && workspaceAllowsRepository(selected, repository);

  useEffect(() => {
    let current = true;
    let initialized = false;
    let generation = 0;
    const load = () => {
      const reading = ++generation;
      void fetch("/api/workspaces/options").then(response => readJson<WorkspaceOptionsResponse>(response)).then(data => {
        if (!current || reading !== generation) return;
        setOptions(data);
        if (!initialized) {
          const first = data.projects[0];
          if (first) { setProject(first.projectName); setRuntime(first.defaultRuntime); setRepository(null); setCoding(false); }
          initialized = true;
        }
      }).catch(error => { if (current && reading === generation) setError(error instanceof Error ? error.message : "Workspace options could not be loaded"); });
    };
    load();
    window.addEventListener("focus", load);
    return () => { current = false; window.removeEventListener("focus", load); };
  }, []);

  useEffect(() => {
    let current = true;
    setBranches([]); setBranchError(null);
    if (coding && project && selected && branchRepository === repository && branchRepository && workspaceAllowsRepository(selected, branchRepository)) void fetch(`/api/workspaces/branches?project=${encodeURIComponent(project)}&repository=${encodeURIComponent(branchRepository)}`)
      .then(response => readJson<WorkspaceBranchesResponse>(response)).then(data => { if (current) setBranches(data.names); })
      .catch(error => { if (current) setBranchError(error instanceof Error ? error.message : "Branches could not be loaded"); });
    return () => { current = false; };
  }, [coding, project, repository, branchRepository, selected]);

  async function start() {
    if (!selected || !task.trim() || busy || !selected.runtimes.includes(runtime) || (coding && (!repositoryAllowed || !branch.trim()))) return;
    setBusy(true); setError(null);
    const body = JSON.stringify({ projectName: selected.projectName, runtime, ...(coding ? { baseBranch: branch, repository } : {}),
      input: runtime === "command" ? { kind: "command", script: task } : { kind: "task", prompt: task } });
    if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
    try {
      const result = await readJson<StartWorkspaceResponse>(await fetch("/api/workspaces", { method: "POST", headers: { ...jsonHeaders, "Idempotency-Key": request.current.key }, body }));
      notifyWorkspaceActivity();
      router.push(`/chats/${result.workspace.chatId}`);
    } catch (error) { setError(error instanceof Error ? error.message : "Workspace could not be started"); }
    finally { setBusy(false); }
  }

  return <Stack gap="md" maw={640} mx="auto" p={{ base: "sm", sm: "lg" }} h="100%" style={{ overflowY: "auto" }} onKeyDown={onModEnter(() => { void start(); })}>
    <Group><ThemeIcon size={44} variant="light"><IconTerminal2 /></ThemeIcon><div><Title order={2}>{t("workspace.new")}</Title><Text size="sm" c="dimmed">{t("workspace.intro")}</Text></div></Group>
    {error && <Alert color="red">{error}</Alert>}
    {!options && !error && <Loader size="sm" />}
    {options && !options.projects.length && <Alert>{t("workspace.notConfigured")}</Alert>}
    <Select label={t("chat.project")} searchable value={project} data={(options?.projects ?? []).map(option => ({ value: option.projectName, label: option.displayName }))}
      onChange={value => { setProject(value); setRepository(null); setCoding(false); setBranch("main"); setRuntime(options?.projects.find(option => option.projectName === value)?.defaultRuntime ?? "command"); }} disabled={busy} />
    {selected?.description && <Text size="sm" c="dimmed">{selected.description}</Text>}
    <Select label={t("workspace.runtime")} value={runtime} allowDeselect={false} onChange={value => setRuntime(value as WorkspaceRuntime)} disabled={busy}
      error={selected && !selected.runtimes.includes(runtime) ? t("workspace.modelUnavailable") : undefined}
      data={[...new Set([...(selected?.runtimes ?? []), runtime])].map(value => ({ value, disabled: !selected?.runtimes.includes(value), label: value === "command" ? t("workspace.command") : value === "codex" ? "Codex" : value === "claude" ? "Claude" : "OpenCode" }))} />
    <Switch label={t("workspace.useRepository")} checked={coding} onChange={event => setCoding(event.currentTarget.checked)} disabled={busy || !selected ||
      (!selected.repositories.length && selected.mode !== "all" && selected.mode !== "new" && !(selected.mode === "owners" && selected.repositoryOwners.length)) || !options?.gitEnabled} />
    {project && <Anchor size="sm" href={`/projects/${encodeURIComponent(project)}/workspace`} target="_blank" rel="noreferrer">{t("workspace.policy.manage")}</Anchor>}
    {coding && <>
      {selected?.mode === "new" && <Text size="sm" c="dimmed">{t("workspace.policy.modeHint.new")}</Text>}
      {selected?.mode === "owners" && !!selected.repositoryOwners.length && <Text size="sm" c="dimmed">{t("workspace.allowedOwners", { owners: selected.repositoryOwners.join(", ") })}</Text>}
      <Autocomplete label={t("workspace.repository")} placeholder="owner/repository" value={repository ?? ""} data={selected?.repositories ?? []}
        onChange={value => { setRepository(value.trim()); setBranch("main"); }} disabled={busy} error={repository && !repositoryAllowed ? t("workspace.repositoryNotAllowed") : undefined} />
      <Autocomplete label={t("workspace.baseBranch")} value={branch} onChange={setBranch} data={branches} disabled={busy} />
      {branchError && <Alert color="red">{branchError}</Alert>}
    </>}
    <Textarea label={runtime === "command" ? t("workspace.script") : t("workspace.task")} description={t("workspace.taskHint")} value={task} onChange={event => setTask(event.currentTarget.value)} autosize minRows={5} maxRows={12} disabled={busy} />
    <Button onClick={() => { void start(); }} loading={busy} disabled={!selected || !selected.runtimes.includes(runtime) || !task.trim() || (coding && (!branch.trim() || !repositoryAllowed))}>{t("workspace.start")}</Button>
  </Stack>;
}
