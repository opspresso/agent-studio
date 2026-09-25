"use client";

import { LoadingText } from "@/app/_components/PageState";
import { useParams } from "next/navigation";
import { Alert } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { useAgentWorkspace } from "../_components/AgentWorkspaceContext";
import { WorkspaceRepositoryPolicySection } from "@/app/workspaces/_components/WorkspaceRepositoryPolicySection";

export default function WorkspaceToolsPage() {
  const { name } = useParams<{ name: string }>();
  const access = useAgentWorkspace();
  const t = useT();
  if (access.error) return <Alert color="red">{access.error}</Alert>;
  if (access.enabled === undefined) return <LoadingText />;
  if (!access.enabled) return <Alert>{t("workspace.enableToolsHint")}</Alert>;
  return <WorkspaceRepositoryPolicySection key={name} agentName={name} />;
}
