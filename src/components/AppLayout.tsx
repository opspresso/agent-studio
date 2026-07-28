"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AppShell,
  Burger,
  Container,
  Group,
  NavLink,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import classes from "./AppLayout.module.css";

const NAV_ITEMS = [
  { href: "/projects", label: "Projects" },
  { href: "/chats", label: "Chats" },
  { href: "/skills", label: "Skills" },
  { href: "/tools", label: "Tools" },
  { href: "/agents", label: "Agents" },
  { href: "/settings", label: "Settings" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppLayout({
  version,
  children,
}: {
  version: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [opened, { toggle, close }] = useDisclosure(false);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 220,
        breakpoint: "sm",
        // Desktop keeps the links in the header, so the navbar exists only as
        // the small-screen drawer.
        collapsed: { mobile: !opened, desktop: true },
      }}
      padding={0}
    >
      <AppShell.Header>
        <Container size="xl" h="100%" px="md">
          <Group h="100%" gap="md" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <UnstyledButton component={Link} href="/" className={classes.brand}>
              <Image src="/logo.png" alt="" width={28} height={28} priority />
              <Text fw={600} fz="lg" visibleFrom="xs">
                Agent Studio
              </Text>
            </UnstyledButton>
            <Group gap={4} h="100%" visibleFrom="sm" wrap="nowrap" component="nav">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={classes.navLink}
                  data-active={isActive(pathname, item.href) || undefined}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                >
                  {item.label}
                </Link>
              ))}
            </Group>
            <Group gap="xs" ml="auto" wrap="nowrap">
              <ThemeToggle />
              <UserMenu />
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.href}
            component={Link}
            href={item.href}
            label={item.label}
            active={isActive(pathname, item.href)}
            onClick={close}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        <Container size="xl" px="md" py="lg" mih="calc(100vh - 9rem)" id="main-content">
          {children}
        </Container>
        <Container size="xl" px="md" pb="lg">
          <Text ta="center" fz="xs" c="dimmed">
            Agent Studio v{version}
          </Text>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
