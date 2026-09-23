"use client";

import { projectHasWorkspaceTools } from "@/domain/project/workspaceAccess";
import { ProjectWorkspaceContext } from "./_components/ProjectWorkspaceContext";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Stack, Text } from "@mantine/core";
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
import { getProject, getConfiguration, type SanitizedProject } from "../lib/api";
import { onConfigurationChange } from "../lib/configurationEvents";
import { projectHasAudioTools } from "@/domain/project/audioAccess";
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
  const base = `/projects/${name}`;

  // One source for "who is looking at this": `canEditProject` below reads the
  // same viewer, and a second hook answering it is a second round trip and a
  // second thing to keep in step.
  const viewer = useViewer();
  const t = useT();
  const [project, setProject] = useState<SanitizedProject | null>(null);
  const [audio, setAudio] = useState<{ name: string; enabled?: boolean; workspace?: boolean; error?: string }>();
  const currentProject = project?.name === name ? project : null;
  const ownerEmail = currentProject?.ownerEmail ?? null;

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const reload = () => {
      const request = ++sequence;
      setAudio({ name });
      // Retry transient reads once; stale responses cannot replace newer settings.
      void (async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const project = await getProject(name);
            if (cancelled || request !== sequence) return;
            setProject(project);
            const { configuration } = await getConfiguration(name);
            if (!cancelled && request === sequence) setAudio({ name,
              enabled: projectHasAudioTools({ configuration: configuration ?? undefined }),
              workspace: projectHasWorkspaceTools({ configuration: configuration ?? undefined }) });
            return;
          } catch (error) {
            if (cancelled || request !== sequence) return;
            if (attempt === 1) setAudio({ name, error: error instanceof Error ? error.message : "Project settings could not be loaded" });
          }
        }
      })();
    };
    reload();
    const unsubscribe = onConfigurationChange(name, reload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [name]);

  const canManage = canEditProject(viewer, ownerEmail);
  const tabs = [
    { href: base, label: t("project.tab.playground"), Icon: IconPlayerPlay },
    { href: `${base}/usage`, label: t("project.tab.usage"), Icon: IconChartBar },
    ...(ownerEmail && viewer?.email === ownerEmail && audio?.name === name && audio.enabled ? [{ href: `${base}/audio`, label: t("audio.title"), Icon: IconSparkles }] : []),
    ...(canManage && audio?.name === name && audio.workspace ? [{ href: `${base}/workspace`, label: t("workspace.toolsTitle"), Icon: IconSparkles }] : []),
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
    <Stack gap="lg">
      <BackLink href="/projects" label={t("nav.projects")} />
      <PageHeader title={currentProject?.displayName || name} Icon={IconSparkles}
        badges={<Badge color="brand">{t("project.badge")}</Badge>}
        details={<Text fz="xs" ff="monospace" c="dimmed">{name}</Text>}>
        {ownerEmail && <OwnerLine ownerEmail={ownerEmail} isMine={viewer?.email === ownerEmail} prefix={t("project.ownedBy")} />}
        {viewer !== null && tierMayCreateProjects(viewer.tier) && <CloneProjectButton sourceName={name} />}
      </PageHeader>
      <PageTabs value={pathname} items={tabs} label={t("project.badge")} />

      <ProjectAudioContext.Provider value={audio?.name === name ? { enabled: audio.enabled, error: audio.error } : {}}>
        <ProjectWorkspaceContext.Provider value={audio?.name === name ? { enabled: audio.workspace, error: audio.error } : {}}>
          {children}
        </ProjectWorkspaceContext.Provider>
      </ProjectAudioContext.Provider>
    </Stack>
  );
}
