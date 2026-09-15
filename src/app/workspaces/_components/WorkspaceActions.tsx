"use client";

import { useState } from "react";
import { Alert, Button, Code, Group, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import type { CodingApprovalResponse } from "@/app/api/workspaces/[id]/actions/route";
import type { WorkspaceDetailResponse } from "@/app/api/workspaces/[id]/route";
import type { CodingAction } from "@/domain/coding/types";

export function WorkspaceActions({ detail, workflows, refresh }: { detail: WorkspaceDetailResponse; workflows: string[]; refresh(): Promise<void> }) {
  const t = useT();
  const [kind, setKind] = useState("commit");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [inputs, setInputs] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = detail.approvals.find(approval => approval.id === detail.workspace.activeActionId);
  const latest = detail.approvals[0];
  const disabled = !!detail.workspace.activeRunId || ["closing", "suspending"].includes(detail.workspace.status);
  const needsMessage = kind === "commit" || kind === "commit-and-push";
  function actionLabel(action: CodingAction) {
    if (action.kind === "commit") return "Commit";
    if (action.kind === "commit-and-push") return "Commit & push";
    if (action.kind === "push") return "Push";
    if (action.kind === "push-main") return t("workspace.pushMain");
    if (action.kind === "merge") return t("workspace.merge");
    if (action.kind === "deploy") return t("workspace.deploy");
    return action.draft ? "Draft PR" : "PR";
  }

  async function perform(approval?: boolean) {
    setBusy(true); setError(null);
    try {
      let result: CodingApprovalResponse;
      if (pending && approval !== undefined) {
        result = await readJson<CodingApprovalResponse>(await fetch(`/api/workspaces/${detail.workspace.id}/actions/${pending.id}`, {
          method: "POST", headers: jsonHeaders, body: JSON.stringify({ approve: approval }),
        }));
      } else {
        let action: CodingAction;
        if (kind === "commit" || kind === "commit-and-push") action = { kind, message: title };
        else if (kind === "push" || kind === "push-main") action = { kind };
        else if (kind === "pr" || kind === "draft") action = { kind: "pull-request", title, body, draft: kind === "draft" };
        else if (kind === "merge") {
          if (!detail.workspace.pullRequest) throw new Error("Create a pull request first");
          action = { kind: "merge", pullRequestNumber: detail.workspace.pullRequest.number, headSha: detail.workspace.pullRequest.headSha };
        } else action = { kind: "deploy", workflow: workflow ?? workflows[0] ?? "", ref: "main", inputs: JSON.parse(inputs) as Record<string, string> };
        result = await readJson<CodingApprovalResponse>(await fetch(`/api/workspaces/${detail.workspace.id}/actions`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(action) }));
      }
      if (result.approval.status === "failed" || result.approval.status === "uncertain") setError(result.approval.result ?? "Action could not be confirmed");
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(false); }
  }

  return <Stack gap="sm">
    {error && <Alert color="red">{error}</Alert>}
    {pending?.status === "pending" ? <>
      <Alert title={t("workspace.reviewAction")} color="yellow">{t("workspace.reviewHint")}</Alert>
      <Text fw={600}>{actionLabel(pending.action)}</Text>
      <Text size="sm">{detail.workspace.coding?.repository} · {detail.workspace.coding?.branch}</Text>
      <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "visible" }}>{JSON.stringify(pending.action, null, 2)}</Code>
      <Text size="xs" c="dimmed">HEAD: {pending.review.headSha}</Text>
      {pending.review.mainHeadSha && <Text size="xs" c="dimmed">main: {pending.review.mainHeadSha} → {pending.review.headSha}</Text>}
      {pending.review.ci === "none" && <Alert color="yellow">{t("workspace.noCi")}</Alert>}
      {pending.action.kind === "push-main" && <Alert color="orange">{t("workspace.pushMainHint")}</Alert>}
      {pending.review.truncated && <Alert color="yellow">{t("workspace.diffTruncated")}</Alert>}
      {pending.review.diff && <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "visible" }}>{pending.review.diff}</Code>}
      <Group><Button color={["merge", "push-main"].includes(pending.action.kind) ? "orange" : undefined} loading={busy} disabled={disabled} onClick={() => { void perform(true); }}>{t("workspace.approve")}</Button>
        <Button variant="default" disabled={busy || disabled} onClick={() => { void perform(false); }}>{t("workspace.reject")}</Button></Group>
    </> : <>
      {pending && <Alert color="yellow">{t("workspace.actionInProgress")}</Alert>}
      <Select label={t("workspace.action")} value={kind} allowDeselect={false} onChange={value => setKind(value ?? "commit")} data={[
        { value: "commit", label: "Commit" }, { value: "commit-and-push", label: "Commit & push" }, { value: "push", label: "Push" },
        { value: "draft", label: "Draft PR" }, { value: "pr", label: "PR" },
        { value: "merge", label: t("workspace.merge"), disabled: !detail.workspace.pullRequest },
        { value: "push-main", label: t("workspace.pushMain"), disabled: detail.workspace.coding?.baseBranch !== "main" },
        { value: "deploy", label: t("workspace.deploy"), disabled: !workflows.length },
      ]} disabled={busy || disabled || !!pending} />
      {(needsMessage || ["draft", "pr"].includes(kind)) && <TextInput label={needsMessage ? t("workspace.commitMessage") : t("workspace.prTitle")} value={title} onChange={event => setTitle(event.currentTarget.value)} />}
      {["draft", "pr"].includes(kind) && <Textarea label={t("workspace.prBody")} value={body} onChange={event => setBody(event.currentTarget.value)} minRows={3} autosize />}
      {kind === "merge" && <Alert color="orange">{t("workspace.mergeHint")}</Alert>}
      {kind === "push-main" && <Alert color="orange">{t("workspace.pushMainHint")}</Alert>}
      {kind === "deploy" && <><Select label={t("workspace.workflow")} value={workflow ?? workflows[0] ?? null} onChange={setWorkflow} data={workflows} /><Textarea label={t("workspace.workflowInputs")} value={inputs} onChange={event => setInputs(event.currentTarget.value)} minRows={3} /><Text size="sm" c="dimmed">{t("workspace.deployHint")}</Text></>}
      <Button loading={busy} disabled={disabled || !!pending || ((needsMessage || ["draft", "pr"].includes(kind)) && !title.trim())} onClick={() => { void perform(); }}>{t("workspace.prepareAction")}</Button>
      {latest && <Text size="sm" c="dimmed">{latest.action.kind}: {latest.status}{latest.result ? ` — ${latest.result}` : ""}</Text>}
    </>}
  </Stack>;
}
