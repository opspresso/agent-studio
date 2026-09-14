"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { Alert, Anchor, Badge, Box, Button, Code, Group, Loader, ScrollArea, Select, Stack, Tabs, Text, Textarea, Title } from "@mantine/core";
import { IconArrowDown, IconPlayerStop, IconSend } from "@tabler/icons-react";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDateTime } from "@/shared/date";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { isSubmitEnter } from "@/app/_lib/modEnter";
import { useWorkspace } from "../_lib/useWorkspace";
import { notifyWorkspaceActivity } from "../_lib/activity";
import { WorkspaceActions } from "./WorkspaceActions";
import type { WorkspaceRunResponse } from "@/app/api/workspaces/[id]/runs/route";
import type { WorkspaceOptionsResponse } from "@/app/api/workspaces/options/route";
import type { MessageKey } from "@/app/_i18n/messages/en";

export function WorkspacePanel({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>("output");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<WorkspaceOptionsResponse | null>(null);
  const request = useRef<{ body: string; key: string } | null>(null);
  const { detail, events, error: loadError, refresh, runId } = useWorkspace(id, selected);
  const { scrollRef, contentRef, isNearBottom, scrollToBottom } = useStickToBottom({ resize: "smooth", initial: "instant" });
  const output = useMemo(() => events.flatMap(event => {
    const data = event.data;
    if (data.kind === "output" || data.kind === "message") return [data.text];
    if (data.kind === "warning") return [`\n⚠ ${data.text}\n`];
    return [];
  }).join(""), [events]);

  useEffect(() => {
    let current = true;
    void fetch("/api/workspaces/options").then(response => readJson<WorkspaceOptionsResponse>(response)).then(data => { if (current) setOptions(data); }).catch(() => {});
    return () => { current = false; };
  }, []);

  async function send() {
    if (!detail || !message.trim() || busy) return;
    setBusy(true); setError(null);
    const body = JSON.stringify(detail.workspace.runtime === "command" ? { kind: "command", script: message } : { kind: "task", prompt: message });
    if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
    try {
      await readJson<WorkspaceRunResponse>(await fetch(`/api/workspaces/${id}/runs`, { method: "POST", headers: { ...jsonHeaders, "Idempotency-Key": request.current.key }, body }));
      setMessage(""); request.current = null; setSelected(null); setTab("output");
      await refresh(); notifyWorkspaceActivity(); void scrollToBottom({ ignoreEscapes: true });
    } catch (error) { setError(error instanceof Error ? error.message : "Workspace request failed"); }
    finally { setBusy(false); }
  }
  async function stop(finish: boolean) {
    setBusy(true); setError(null);
    try { await assertOk(await fetch(`/api/workspaces/${id}${finish ? "" : "/runs"}`, { method: "DELETE" })); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Workspace could not be stopped"); }
    finally { setBusy(false); }
  }

  if (!detail) return loadError ? <Alert color="red">{loadError}</Alert> : <Group p="lg"><Loader size="sm" /><Text>{t("common.loading")}</Text></Group>;
  const workspace = detail.workspace;
  const run = detail.runs.find(run => run.id === runId);
  const blocked = busy || !!workspace.activeRunId || !!workspace.activeActionId || ["closing", "suspending"].includes(workspace.status);
  const status = (value: string) => t(`workspace.status.${value}` as MessageKey);
  const workflows = options?.projects.find(project => project.projectName === workspace.projectName)?.deploymentWorkflows ?? [];

  return <Stack h="100%" gap="sm">
    <Group justify="space-between" wrap="wrap">
      <div><Title order={2} size="h4">{workspace.title}</Title><Group gap="xs" mt={4}><Text size="xs" c="dimmed">{workspace.projectName} · {workspace.runtime}</Text><Badge variant="light">{status(workspace.status)}</Badge></Group></div>
      <Button size="xs" variant="default" disabled={busy || workspace.status === "closed" || workspace.status === "closing"} onClick={() => { void stop(true); }}>{t("workspace.finish")}</Button>
    </Group>
    {workspace.coding && <Group gap="xs"><Code>{workspace.coding.branch}</Code><Text size="xs" c="dimmed">← {workspace.coding.baseBranch}</Text>
      {workspace.pullRequest && <Anchor href={workspace.pullRequest.url} target="_blank" rel="noreferrer" size="sm">{workspace.pullRequest.draft ? "Draft PR" : "PR"} #{workspace.pullRequest.number} · {workspace.pullRequest.ci}</Anchor>}</Group>}
    {(error || loadError || workspace.error) && <Alert color="red" py="xs">{error ?? loadError ?? workspace.error}</Alert>}
    <Select label={t("workspace.runs")} size="xs" value={runId ?? null} allowDeselect={false} onChange={setSelected}
      data={detail.runs.map(run => ({ value: run.id, label: `${formatDateTime(run.createdAt, locale)} · ${status(run.status)}` }))} />
    <Tabs value={tab} onChange={setTab} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Tabs.List><Tabs.Tab value="output">{t("workspace.output")}</Tabs.Tab><Tabs.Tab value="diff">Diff</Tabs.Tab><Tabs.Tab value="checks">{t("workspace.checks")}</Tabs.Tab>{workspace.coding && <Tabs.Tab value="actions">{t("workspace.actions")}</Tabs.Tab>}</Tabs.List>
      <Box style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <ScrollArea h="100%" viewportRef={scrollRef}>
          <div ref={contentRef}><Box p="sm">
            <Tabs.Panel value="output"><Stack gap="sm">
              {run && <Box p="sm" bg="var(--mantine-color-default-hover)"><Text size="xs" c="dimmed">{t("workspace.request")}</Text><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{run.input.kind === "task" ? run.input.prompt : run.input.script}</Text></Box>}
              {run?.status === "queued" && <Alert>{t("workspace.queuedHint")}</Alert>}
              {run?.status === "running" && <Group gap="xs"><Loader size="xs" /><Text size="sm">{t("workspace.runningHint")}</Text></Group>}
              {(events[0]?.seq ?? 1) > 1 && <Text size="xs" c="dimmed">{t("workspace.outputWindow")}</Text>}
              <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "visible" }}>{output || t("workspace.noOutput")}</Code>
              {run?.error && <Alert color="red">{run.error}</Alert>}
            </Stack></Tabs.Panel>
            <Tabs.Panel value="diff">{run?.diffTruncated && <Alert color="yellow">{t("workspace.diffTruncated")}</Alert>}<Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "visible" }}>{run?.diff || t("workspace.noDiff")}</Code></Tabs.Panel>
            <Tabs.Panel value="checks"><Stack>{run?.checks.length ? run.checks.map(check => <Box key={check.name} p="sm" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: "var(--mantine-radius-md)" }}>
              <Group justify="space-between"><Text fw={600}>{check.name}</Text><Badge color={check.status === "failed" ? "red" : check.status === "passed" ? "green" : "gray"}>{status(check.status)}</Badge></Group>
              <Code>{check.command}</Code>{check.exitCode !== undefined && <Text size="xs">{t("workspace.exitCode")}: {check.exitCode}</Text>}
              <Code block mt="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "visible" }}>{check.output}</Code>
              {check.truncated && <Text size="xs" c="dimmed">{t("workspace.outputWindow")}</Text>}
            </Box>) : <Text c="dimmed">{t("workspace.noChecks")}</Text>}</Stack></Tabs.Panel>
            {workspace.coding && <Tabs.Panel value="actions"><WorkspaceActions detail={detail} workflows={workflows} refresh={refresh} /></Tabs.Panel>}
          </Box></div>
        </ScrollArea>
        {!isNearBottom && <Button size="compact-xs" variant="default" pos="absolute" bottom={12} right={12} leftSection={<IconArrowDown size={14} />} onClick={() => { void scrollToBottom(); }}>{t("workspace.latest")}</Button>}
      </Box>
    </Tabs>
    {workspace.activeActionId && <Text size="xs" c="dimmed">{t("workspace.pendingActionHint")}</Text>}
    <Textarea aria-label={t("workspace.followUp")} placeholder={workspace.runtime === "command" ? t("workspace.scriptPlaceholder") : t("workspace.followUp")} value={message} onChange={event => setMessage(event.currentTarget.value)} disabled={blocked} autosize minRows={2} maxRows={6}
      onKeyDown={event => { if (isSubmitEnter(event) && !event.shiftKey) { event.preventDefault(); void send(); } }} />
    <Group justify="space-between"><Text size="xs" c="dimmed">{t("workspace.sessionHint")}</Text>{workspace.activeRunId ? <Button color="red" variant="light" leftSection={<IconPlayerStop size={14} />} onClick={() => { void stop(false); }} loading={busy}>{t("workspace.stop")}</Button>
      : <Button leftSection={<IconSend size={14} />} disabled={blocked || !message.trim()} onClick={() => { void send(); }} loading={busy}>{t("workspace.send")}</Button>}</Group>
  </Stack>;
}
