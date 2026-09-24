"use client";

import { ProjectWorkspaceContext } from "./_components/ProjectWorkspaceContext";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import {
  IconAdjustments,
  IconApi,
  IconChartBar,
  IconPlayerPlay,
  IconPhoto,
  IconPlugConnected,
  IconRoute,
  IconSparkles,
} from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { getProject, type SanitizedProject } from "../lib/api";
import { onConfigurationChange } from "../lib/configurationEvents";
import { ProjectAudioContext } from "./_components/ProjectAudioContext";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { tierMayCreateProjects } from "@/domain/member/tiers";
import { CloneProjectButton } from "./_components/CloneProjectButton";
import { PageHeader } from "@/app/_components/PageHeader";
import { PageTabs } from "@/app/_components/PageTabs";
import { BackLink } from "@/app/_components/BackLink";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ name: string }>();
  const pathname = usePathname();
  const name = params.name;
  const base = `/agents/${name}`;

  // One source for "who is looking at this": `canEditProject` below reads the
  // same viewer, and a second hook answering it is a second round trip and a
  // second thing to keep in step.
  const viewer = useViewer();
  const t = useT();
  const [projectState, setProjectState] = useState<{ name: string; project: SanitizedProject | null; error: string | null } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const currentState = projectState?.name === name ? projectState : null;
  const currentProject = currentState?.project ?? null;
  const ownerEmail = currentProject?.ownerEmail ?? null;

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const reload = () => {
      const request = ++sequence;
      void getProject(name).then((project) => {
        if (!cancelled && request === sequence) setProjectState({ name, project, error: null });
      }).catch((error) => {
        if (!cancelled && request === sequence) setProjectState({ name, project: null,
          error: error instanceof Error ? error.message : "Project could not be loaded" });
      });
    };
    reload();
    const unsubscribe = onConfigurationChange(name, reload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [name, retryKey]);

  const canManage = canEditProject(viewer, ownerEmail);
  const tabs = [
    { href: base, label: t("project.tab.playground"), Icon: IconPlayerPlay },
    { href: `${base}/usage`, label: t("project.tab.usage"), Icon: IconChartBar },
    ...(ownerEmail && viewer?.email === ownerEmail && currentProject?.audioToolsEnabled ? [{ href: `${base}/audio`, label: t("audio.title"), Icon: IconSparkles }] : []),
    ...(canManage && currentProject?.workspaceToolsEnabled ? [{ href: `${base}/workspace`, label: t("workspace.toolsTitle"), Icon: IconSparkles }] : []),
    // Gated like Traces: these hold other people's runtime output, and the
    // delete here is the only way a Slack or trigger run's artifact is removed.
    ...(canManage
      ? [{ href: `${base}/artifacts`, label: t("project.tab.artifacts"), Icon: IconPhoto }]
      : []),
    ...(canManage
      ? [{ href: `${base}/traces`, label: t("project.tab.traces"), Icon: IconRoute }]
      : []),
    { href: `${base}/api-reference`, label: t("project.tab.apiReference"), Icon: IconApi },
    // How other systems reach the project — bots and the API token. Owner
    // gated like Settings, which is where these lived until the bots outgrew it.
    ...(canManage
      ? [{ href: `${base}/integrations`, label: t("project.tab.integrations"), Icon: IconPlugConnected }]
      : []),
    ...(canManage
      ? [{ href: `${base}/settings`, label: t("project.tab.settings"), Icon: IconAdjustments }]
      : []),
  ];

  return (
    // Param-only navigation can reuse this client layout. Remount its children
    // so a draft or pending response from one Agent cannot enter another.
    <Stack key={name} gap="lg">
      <BackLink href="/agents" label={t("nav.agents")} />
      <PageHeader title={currentProject?.displayName || name} Icon={IconSparkles}
        details={<Text fz="xs" ff="monospace" c="dimmed">{name}</Text>}>
        {ownerEmail && <OwnerLine ownerEmail={ownerEmail} isMine={viewer?.email === ownerEmail} prefix={t("project.ownedBy")} />}
        {viewer !== null && tierMayCreateProjects(viewer.tier) && <CloneProjectButton sourceName={name} />}
      </PageHeader>
      {currentState?.error && <Alert color="red"><Group justify="space-between" gap="sm">
        <Text size="sm">{currentState.error}</Text>
        <Button size="xs" variant="light" onClick={() => setRetryKey(key => key + 1)}>{t("error.retry")}</Button>
      </Group></Alert>}
      <PageTabs value={pathname} items={tabs} label={t("project.badge")} />

      <ProjectAudioContext.Provider value={currentState ? { enabled: currentProject?.audioToolsEnabled, error: currentState.error ?? undefined } : {}}>
        <ProjectWorkspaceContext.Provider value={currentState ? { enabled: currentProject?.workspaceToolsEnabled, error: currentState.error ?? undefined } : {}}>
          {children}
        </ProjectWorkspaceContext.Provider>
      </ProjectAudioContext.Provider>
    </Stack>
  );
}
