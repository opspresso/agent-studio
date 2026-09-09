"use client";

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
import { getProject, type SanitizedProject } from "../lib/api";
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
  const currentProject = project?.name === name ? project : null;
  const ownerEmail = currentProject?.ownerEmail ?? null;

  useEffect(() => {
    let cancelled = false;
    getProject(name)
      .then((project) => !cancelled && setProject(project))
      // Retried once rather than swallowed. The owner is read only to decide
      // whether this person may manage the project, so a read that fails leaves
      // `ownerEmail` null and the *owner* is shown a read-only header — the tabs
      // their own project needs, missing, with nothing said. Every other ignored
      // rejection in this codebase carries a line saying why it is harmless;
      // this one was not harmless.
      .catch(() =>
        getProject(name)
          .then((project) => !cancelled && setProject(project))
          // A second failure is a project this browser genuinely cannot read,
          // which the page below reports on its own — the header simply stays
          // as it is rather than claiming anything about who is looking.
          .catch(() => {}),
      );
    return () => {
      cancelled = true;
    };
  }, [name]);

  const canManage = canEditProject(viewer, ownerEmail);
  const tabs = [
    { href: base, label: t("project.tab.playground"), Icon: IconPlayerPlay },
    { href: `${base}/versions`, label: t("project.tab.versions"), Icon: IconHistory },
    { href: `${base}/compare`, label: t("project.tab.compare"), Icon: IconGitCompare },
    { href: `${base}/usage`, label: t("project.tab.usage"), Icon: IconChartBar },
    ...(ownerEmail && viewer?.email === ownerEmail ? [{ href: `${base}/audio`, label: t("audio.title"), Icon: IconSparkles }] : []),
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

      {children}
    </Stack>
  );
}
