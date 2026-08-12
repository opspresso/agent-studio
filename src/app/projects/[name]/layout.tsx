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
  IconRoute,
  IconSparkles,
} from "@tabler/icons-react";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { getProject } from "../lib/api";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
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
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProject(name)
      .then((project) => !cancelled && setOwnerEmail(project.ownerEmail))
      // Retried once rather than swallowed. The owner is read only to decide
      // whether this person may manage the project, so a read that fails leaves
      // `ownerEmail` null and the *owner* is shown a read-only header — the tabs
      // their own project needs, missing, with nothing said. Every other ignored
      // rejection in this codebase carries a line saying why it is harmless;
      // this one was not harmless.
      .catch(() =>
        getProject(name)
          .then((project) => !cancelled && setOwnerEmail(project.ownerEmail))
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
    { href: base, label: "Playground", Icon: IconPlayerPlay },
    { href: `${base}/versions`, label: "Versions", Icon: IconHistory },
    { href: `${base}/compare`, label: "Compare", Icon: IconGitCompare },
    { href: `${base}/usage`, label: "Usage", Icon: IconChartBar },
    // Gated like Traces: these hold other people's runtime output, and the
    // delete here is the only way a Slack or trigger run's artifact is removed.
    ...(canManage
      ? [{ href: `${base}/artifacts`, label: "Artifacts", Icon: IconPhoto }]
      : []),
    ...(canManage ? [{ href: `${base}/traces`, label: "Traces", Icon: IconRoute }] : []),
    { href: `${base}/api-reference`, label: "API Reference", Icon: IconApi },
    ...(canManage ? [{ href: `${base}/settings`, label: "Settings", Icon: IconAdjustments }] : []),
  ];

  return (
    <Stack gap="xl">
      <div className={classes.workspaceHeader}>
        <Group justify="space-between" align="flex-start" gap="lg" wrap="wrap">
          <Group gap="md" wrap="nowrap">
            <ActionIcon component={Link} href="/projects" variant="default" size="lg" aria-label="Projects">
              <IconArrowLeft size={17} />
            </ActionIcon>
            <ThemeIcon
              size={46}
              radius="lg"
              variant="gradient"
              gradient={{ from: "brand.6", to: "violet.5", deg: 135 }}
            >
              <IconSparkles size={22} />
            </ThemeIcon>
            <div>
              <Group gap="xs">
                <Title order={1} fz="h3" lts="-0.025em">
                  {name}
                </Title>
                <Badge variant="light" color="brand" radius="xl">
                  AI project
                </Badge>
              </Group>
              <Text fz="sm" c="dimmed" mt={2}>
                Design, test, and observe this project from one workspace.
              </Text>
            </div>
          </Group>
          {ownerEmail && (
            <OwnerLine
              ownerEmail={ownerEmail}
              isMine={viewer?.email === ownerEmail}
              prefix="Owned by "
            />
          )}
        </Group>
      </div>

      {/*
       * `value` is the pathname rather than tab state: navigation is what
       * changes the tab, so deriving it keeps the highlight correct on a
       * direct load or a back button.
       */}
      <Tabs value={pathname} variant="none" classNames={{ list: classes.tabs, tab: classes.tab }}>
        <Tabs.List>
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
