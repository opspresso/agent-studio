"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Autocomplete, Button, Group, Loader, Select, Stack, Switch, Text, Textarea, ThemeIcon, Title } from "@mantine/core";
import { IconTerminal2 } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { onModEnter } from "@/app/_lib/modEnter";
import { notifyWorkspaceActivity } from "../_lib/activity";
import type { WorkspaceOptionsResponse } from "@/app/api/workspaces/options/route";
import type { WorkspaceBranchesResponse } from "@/app/api/workspaces/branches/route";
import type { StartWorkspaceResponse } from "@/app/api/workspaces/route";
import type { WorkspaceRuntime } from "@/domain/workspace/types";

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
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ body: string; key: string } | null>(null);
  const selected = options?.projects.find(option => option.projectName === project);

  useEffect(() => {
    let current = true;
    void fetch("/api/workspaces/options").then(response => readJson<WorkspaceOptionsResponse>(response)).then(data => {
      if (!current) return;
      setOptions(data);
      const first = data.projects[0];
      if (first) { setProject(first.projectName); setRuntime(first.runtimes[0]!); setRepository(first.repositories[0] ?? null); setCoding(!!first.repositories.length && data.gitEnabled && first.runtimes[0] !== "command"); }
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Workspace options could not be loaded"); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setBranches([]);
    if (coding && project && repository) void fetch(`/api/workspaces/branches?project=${encodeURIComponent(project)}&repository=${encodeURIComponent(repository)}`)
      .then(response => readJson<WorkspaceBranchesResponse>(response)).then(data => { if (current) setBranches(data.names); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Branches could not be loaded"); });
    return () => { current = false; };
  }, [coding, project, repository]);

  async function start() {
    if (!selected || !task.trim() || busy) return;
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
      onChange={value => { setProject(value); setRepository(options?.projects.find(option => option.projectName === value)?.repositories[0] ?? null); setCoding(false); setBranch("main"); setRuntime(options?.projects.find(option => option.projectName === value)?.runtimes[0] ?? "command"); }} disabled={busy} />
    {selected?.description && <Text size="sm" c="dimmed">{selected.description}</Text>}
    <Select label={t("workspace.runtime")} value={runtime} allowDeselect={false} onChange={value => setRuntime(value as WorkspaceRuntime)} disabled={busy}
      data={(selected?.runtimes ?? []).map(value => ({ value, label: value === "command" ? t("workspace.command") : value === "codex" ? "Codex" : value === "claude" ? "Claude" : "OpenCode" }))} />
    <Switch label={t("workspace.useRepository")} checked={coding} onChange={event => setCoding(event.currentTarget.checked)} disabled={busy || !selected?.repositories.length || !options?.gitEnabled} />
    {coding && <><Select label={t("workspace.repository")} value={repository} data={selected?.repositories ?? []} onChange={value => { setRepository(value); setBranch("main"); }} allowDeselect={false} disabled={busy} /><Autocomplete label={t("workspace.baseBranch")} value={branch} onChange={setBranch} data={branches} disabled={busy} /></>}
    <Textarea label={runtime === "command" ? t("workspace.script") : t("workspace.task")} description={t("workspace.taskHint")} value={task} onChange={event => setTask(event.currentTarget.value)} autosize minRows={5} maxRows={12} disabled={busy} />
    <Button onClick={() => { void start(); }} loading={busy} disabled={!selected || !task.trim() || (coding && (!branch || !repository))}>{t("workspace.start")}</Button>
  </Stack>;
}
