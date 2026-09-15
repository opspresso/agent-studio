"use client";

import { projectHasWorkspaceTools } from "@/domain/project/workspaceAccess";
import { ProjectWorkspaceContext } from "./_components/ProjectWorkspaceContext";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionIcon, Badge, Group, Stack, Tabs, Text, ThemeIcon, Title } from "@mantine/core";
import {
  IconAdjustments,
  IconApi,
  IconArrowLeft,
  IconChartBar,
  IconGitCompare,
  IconHistory,
  IconPlayerPlay,
  IconPhoto,
  IconPlugConnected,
  IconRoute,
  IconSparkles,
} from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { getProject, getVersion, listVersions, type SanitizedProject } from "../lib/api";
import { onVersionChange } from "../lib/versionEvents";
import { projectHasAudioTools } from "@/domain/project/audioAccess";
import { ProjectAudioContext } from "./_components/ProjectAudioContext";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { tierMayCreateProjects } from "@/domain/member/tiers";
import { CloneProjectButton } from "./_components/CloneProjectButton";
import classes from "./ProjectLayout.module.css";

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
            const versions = project.projectType !== "agent" ? [] : project.publishedVersion
              ? [await getVersion(name, project.publishedVersion)] : await listVersions(name);
            if (!cancelled && request === sequence) setAudio({ name, enabled: projectHasAudioTools(project, versions), workspace: projectHasWorkspaceTools(project, versions) });
            return;
          } catch (error) {
            if (cancelled || request !== sequence) return;
            if (attempt === 1) setAudio({ name, error: error instanceof Error ? error.message : "Project settings could not be loaded" });
          }
        }
      })();
    };
    reload();
    const unsubscribe = onVersionChange(name, reload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [name]);

  const canManage = canEditProject(viewer, ownerEmail);
  const tabs = [
    { href: base, label: t("project.tab.playground"), Icon: IconPlayerPlay },
    { href: `${base}/versions`, label: t("project.tab.versions"), Icon: IconHistory },
    { href: `${base}/compare`, label: t("project.tab.compare"), Icon: IconGitCompare },
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
    // How other systems reach the project — bots, A2A, the API token. Owner
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
      <div className={classes.workspaceHeader}>
        <Group justify="space-between" align="flex-start" gap="lg" wrap="wrap">
          <Group gap="md" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 280px" }}>
            <ActionIcon
              component={Link}
              href="/projects"
              variant="default"
              size="lg"
              aria-label={t("nav.projects")}
            >
              <IconArrowLeft size={17} />
            </ActionIcon>
            <ThemeIcon
              size={40}
              radius="md"
              variant="light"
            >
              <IconSparkles size={22} />
            </ThemeIcon>
            <div style={{ minWidth: 0 }}>
              <Group gap="xs">
                <Title order={1} fz="h3" lts="-0.025em" style={{ overflowWrap: "anywhere" }}>
                  {currentProject?.displayName || name}
                </Title>
                <Badge variant="light" color="brand" radius="xl">
                  {t("project.badge")}
                </Badge>
              </Group>
              <Text fz="xs" ff="monospace" c="dimmed" mt={4} style={{ overflowWrap: "anywhere" }}>
                {name}
              </Text>
            </div>
          </Group>
          <Group gap="md">
            {ownerEmail && (
              <OwnerLine
                ownerEmail={ownerEmail}
                isMine={viewer?.email === ownerEmail}
                prefix={t("project.ownedBy")}
              />
            )}
            {viewer !== null && tierMayCreateProjects(viewer.tier) && (
              <CloneProjectButton sourceName={name} />
            )}
          </Group>
        </Group>
      </div>

      {/*
       * `value` is the pathname rather than tab state: navigation is what
       * changes the tab, so deriving it keeps the highlight correct on a
       * direct load or a back button.
       */}
      <Tabs value={pathname} variant="none" classNames={{ list: classes.tabs, tab: classes.tab }}>
        <Tabs.List aria-label={t("project.badge")}>
          {tabs.map(({ Icon, ...tab }) => (
            <Tabs.Tab
              key={tab.href}
              value={tab.href}
              renderRoot={(props) => <Link href={tab.href} {...props} />}
            >
              <Icon size={15} stroke={1.8} />
              {tab.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      <ProjectAudioContext.Provider value={audio?.name === name ? { enabled: audio.enabled, error: audio.error } : {}}>
        <ProjectWorkspaceContext.Provider value={audio?.name === name ? { enabled: audio.workspace, error: audio.error } : {}}>
          {children}
        </ProjectWorkspaceContext.Provider>
      </ProjectAudioContext.Provider>
    </Stack>
  );
}
