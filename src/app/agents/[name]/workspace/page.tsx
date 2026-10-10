"use client";

import { LoadingText } from "@/app/_components/PageState";
import { useParams } from "next/navigation";
import { Alert, Stack } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { useAgentWorkspace } from "../_components/AgentWorkspaceContext";
import { WorkspaceRepositoryPolicySection, WorkspaceToolsHeading } from "@/app/workspaces/_components/WorkspaceRepositoryPolicySection";

export default function WorkspaceToolsPage() {
  const { name } = useParams<{ name: string }>();
  const access = useAgentWorkspace();
  const t = useT();
  if (access.error || access.enabled !== true) return <Stack gap="lg">
    <WorkspaceToolsHeading />
    {access.error ? <Alert color="red">{access.error}</Alert>
      : access.enabled === undefined ? <LoadingText /> : <Alert>{t("workspace.enableToolsHint")}</Alert>}
  </Stack>;
  return <WorkspaceRepositoryPolicySection key={name} agentName={name} />;
}
