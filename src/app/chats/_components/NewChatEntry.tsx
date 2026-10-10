"use client";

import { canRunAgents, useViewer } from "@/app/_lib/useViewer";
import { useState } from "react";
import { Alert, Box, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { NewChatPanel } from "./NewChatPanel";
import { NewWorkspaceForm } from "@/app/workspaces/_components/NewWorkspaceForm";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { IconMessageCircle } from "@tabler/icons-react";

export function NewChatEntry({ workspacesEnabled }: { workspacesEnabled: boolean }) {
  const t = useT();
  const viewer = useViewer();
  const canRun = canRunAgents(viewer);
  const [mode, setMode] = useState("chat");
  if (!canRun) return <Stack gap="sm">
    <PageHeader compact Icon={IconMessageCircle} title={t("chat.new")} />
    {viewer === null ? <LoadingText /> : <Alert>{t("common.memberExecutionRequired")}</Alert>}
  </Stack>;
  if (!workspacesEnabled) return <NewChatPanel />;
  return <Stack h="100%" gap="sm">
    <Group justify="space-between" gap="sm" wrap="wrap">
      <Text fz="sm" fw={600}>{t("chat.startMode")}</Text>
      <SegmentedControl aria-label={t("chat.startMode")} value={mode} onChange={setMode}
        data={[{ value: "chat", label: t("chat.kind") }, { value: "workspace", label: t("workspace.kind") }]} />
    </Group>
    <Box style={{ flex: 1, minHeight: 0 }}>{mode === "workspace" ? <NewWorkspaceForm /> : <NewChatPanel />}</Box>
  </Stack>;
}
