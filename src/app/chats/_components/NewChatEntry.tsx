"use client";

import { useState } from "react";
import { Box, SegmentedControl, Stack } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { NewChatPanel } from "./NewChatPanel";
import { NewWorkspaceForm } from "@/app/workspaces/_components/NewWorkspaceForm";

export function NewChatEntry({ workspacesEnabled }: { workspacesEnabled: boolean }) {
  const t = useT();
  const [mode, setMode] = useState("chat");
  if (!workspacesEnabled) return <NewChatPanel />;
  return <Stack h="100%" gap="sm">
    <SegmentedControl value={mode} onChange={setMode} data={[{ value: "chat", label: t("chat.kind") }, { value: "workspace", label: t("workspace.kind") }]} />
    <Box style={{ flex: 1, minHeight: 0 }}>{mode === "workspace" ? <NewWorkspaceForm /> : <NewChatPanel />}</Box>
  </Stack>;
}
