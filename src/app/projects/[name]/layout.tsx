"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Anchor, Group, Stack, Tabs, Text } from "@mantine/core";
import { useSession } from "@/lib/auth-client";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { getProject } from "../lib/api";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ name: string }>();
  const pathname = usePathname();
  const name = params.name;
  const base = `/projects/${name}`;

  const { data: session } = useSession();
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProject(name)
      .then((project) => !cancelled && setOwnerEmail(project.ownerEmail))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [name]);

  const tabs = [
    { href: base, label: "Playground" },
    { href: `${base}/versions`, label: "Versions" },
    { href: `${base}/usage`, label: "Usage" },
    { href: `${base}/traces`, label: "Traces" },
    { href: `${base}/api-reference`, label: "API Reference" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <Stack gap="lg">
      <Group gap="sm">
        <Anchor component={Link} href="/projects" fz="sm" c="dimmed">
          ← Projects
        </Anchor>
        <Text ff="monospace" fz="sm" fw={500}>
          {name}
        </Text>
        {ownerEmail && (
          <OwnerLine
            ownerEmail={ownerEmail}
            isMine={session?.user.email === ownerEmail}
            prefix="owner: "
          />
        )}
      </Group>

      {/*
       * `value` is the pathname rather than tab state: navigation is what
       * changes the tab, so deriving it keeps the highlight correct on a
       * direct load or a back button.
       */}
      <Tabs value={pathname} variant="default">
        <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab.href}
              value={tab.href}
              renderRoot={(props) => <Link href={tab.href} {...props} />}
            >
              {tab.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      {children}
    </Stack>
  );
}
