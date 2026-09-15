"use client";

import { useParams } from "next/navigation";
import { Alert, Loader } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { useProjectWorkspace } from "../_components/ProjectWorkspaceContext";
import { WorkspaceRepositoryPolicySection } from "@/app/workspaces/_components/WorkspaceRepositoryPolicySection";

export default function WorkspaceToolsPage() {
  const { name } = useParams<{ name: string }>();
  const access = useProjectWorkspace();
  const t = useT();
  if (access.error) return <Alert color="red">{access.error}</Alert>;
  if (access.enabled === undefined) return <Loader size="sm" />;
  if (!access.enabled) return <Alert>{t("workspace.enableToolsHint")}</Alert>;
  return <WorkspaceRepositoryPolicySection key={name} projectName={name} />;
}
