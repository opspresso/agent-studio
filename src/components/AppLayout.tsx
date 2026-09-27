"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  AppShell,
  Burger,
  Group,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconBook2,
  IconChartBar,
  IconChevronRight,
  IconCompass,
  IconCpu,
  IconRobot,
  IconMessageCircle,
  IconPhoto,
  IconPackage,
  IconSettings,
  IconShieldCheck,
  IconTool,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useT } from "@/app/_i18n/provider";
import { tierAtLeast } from "@/domain/member/tiers";
import type { Viewer } from "@/lib/viewer";
import type { Branding } from "@/shared/branding";
import type { SignInProviders } from "./SignInButton";
import { LocaleToggle } from "./LocaleToggle";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import classes from "./AppLayout.module.css";
import { redirectToLogin } from "@/app/_lib/authRedirect";
import { isPublicPagePath } from "@/shared/pageAccess";

/*
 * Translate labels at render, but gate navigation by stable group keys.
 * `satisfies` checks every message key against the catalogue.
 */
const NAV_GROUPS = [
  {
    key: "workspace",
    label: "nav.group.workspace",
    items: [
      { href: "/", label: "nav.overview", Icon: IconChartBar },
      { href: "/agents", label: "nav.agents", Icon: IconRobot },
      { href: "/chats", label: "nav.chats", Icon: IconMessageCircle },
      { href: "/artifacts", label: "nav.artifacts", Icon: IconPhoto },
    ],
  },
  {
    key: "intelligence",
    label: "nav.group.intelligence",
    // Plugins are the source that fills the skill and tool registries, followed
    // by the other registries an Agent can draw on.
    items: [
      { href: "/plugins", label: "nav.plugins", Icon: IconPackage },
      { href: "/skills", label: "nav.skills", Icon: IconBook2 },
      { href: "/tools", label: "nav.tools", Icon: IconTool },
      { href: "/models", label: "nav.models", Icon: IconCpu },
    ],
  },
  {
    key: "system",
    label: "nav.group.system",
    items: [
      { href: "/members", label: "nav.members", Icon: IconUsers },
      { href: "/audit", label: "nav.audit", Icon: IconShieldCheck },
      { href: "/settings", label: "nav.settings", Icon: IconSettings },
    ],
  },
] as const satisfies ReadonlyArray<{
  key: string;
  label: MessageKey;
  items: ReadonlyArray<{ href: string; label: MessageKey; Icon: typeof IconChartBar }>;
}>;

/**
 * Profile and Guide stay pinned below the scrollable work and registry groups.
 */
const PERSONAL_ITEMS = [
  { href: "/profile", label: "nav.profile", Icon: IconUser },
  { href: "/guide", label: "nav.guide", Icon: IconCompass },
] as const satisfies ReadonlyArray<{
  href: string;
  label: MessageKey;
  Icon: typeof IconChartBar;
}>;

/**
 * Which groups this viewer is offered.
 *
 * Both gates key on the group's `key` for the reason the comment above gives —
 * a translated label stops matching the moment the sidebar speaks Korean. The
 * intelligence half names the same rung `withMemberAuth` does, so the sidebar
 * and the routes behind it cannot drift on who may read a registry; the pages
 * are turned away server-side regardless, since a hidden link is not a closed
 * door.
 */
function visibleTo(viewer: Viewer | null) {
  return (group: (typeof NAV_GROUPS)[number]): boolean => {
    if (group.key === "system") {
      return viewer?.isAdmin === true;
    }
    if (group.key === "intelligence") {
      return viewer !== null && tierAtLeast(viewer.tier, "member");
    }
    return true;
  };
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/" || pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppLayout({
  branding,
  version,
  viewer,
  userImage,
  signInProviders,
  children,
}: {
  branding: Branding;
  version: string;
  /** Resolved by the root layout; `null` when nobody is signed in. */
  viewer: Viewer | null;
  /**
   * The identity provider's picture for this account, or `null`. It rides
   * beside the viewer rather than inside it: `Viewer` is what `GET /api/me`
   * answers with and what the pages gate on, and a face is neither.
   */
  userImage: string | null;
  /** What the header's sign-in control offers a signed-out visitor. */
  signInProviders: SignInProviders;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const t = useT();
  const [opened, { toggle, close }] = useDisclosure(false);
  const navViewport = useRef<HTMLDivElement>(null);
  const requiresLogin = viewer === null && !isPublicPagePath(pathname);

  useEffect(() => {
    if (requiresLogin) {
      redirectToLogin();
    }
  }, [pathname, viewer]);

  useEffect(() => {
    const viewport = navViewport.current;
    const active = viewport?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!viewport || !active || viewport.clientHeight === 0) return;
    const bounds = viewport.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.bottom > bounds.bottom) {
      viewport.scrollTop += item.bottom - bounds.bottom;
    } else if (item.top < bounds.top) {
      viewport.scrollTop += item.top - bounds.top;
    }
  }, [pathname, opened, viewer?.tier, viewer?.isAdmin]);

  if (requiresLogin) {
    return null;
  }

  // Resolve navigation from the server-supplied viewer so initial SSR and
  // hydration agree. Signed-out visitors receive no workspace navigation.
  const showNav = viewer !== null;

  const navLink = ({
    href,
    label,
    Icon,
  }: {
    href: string;
    label: MessageKey;
    Icon: typeof IconChartBar;
  }) => {
    const active = isActive(pathname, href);
    return (
      <UnstyledButton
        key={href}
        component={Link}
        href={href}
        className={classes.navLink}
        data-active={active || undefined}
        aria-current={active ? "page" : undefined}
        onClick={close}
      >
        <ThemeIcon
          variant="transparent"
          color={active ? "brand" : "gray"}
          size={30}
          radius="md"
        >
          <Icon size={17} stroke={1.8} />
        </ThemeIcon>
        <Text fz="sm" fw={active ? 600 : 450}>
          {t(label)}
        </Text>
        <IconChevronRight className={classes.navArrow} size={14} />
      </UnstyledButton>
    );
  };

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{
        width: 232,
        breakpoint: "md",
        collapsed: { mobile: !opened || !showNav, desktop: !showNav },
      }}
      padding={0}
    >
      <a
        href="#main-content"
        className={classes.skipLink}
        onClick={() => {
          close();
          document.getElementById("main-content")?.focus();
        }}
      >
        {t("chrome.skipToContent")}
      </a>
      <AppShell.Header className={classes.header}>
        <Group h="100%" gap="md" wrap="nowrap" px={{ base: "md", md: "lg" }}>
            {showNav && (
              <Burger
                opened={opened}
                onClick={toggle}
                hiddenFrom="md"
                size="sm"
                aria-label={t(opened ? "chrome.closeNavigation" : "chrome.openNavigation")}
              />
            )}
            <UnstyledButton component={Link} href="/" className={classes.brand}>
              <span className={classes.logoWrap}>
                <Image src={branding.logoUrl} alt="" width={28} height={28} priority />
              </span>
              <div className={classes.brandText}>
                <Text fw={650} fz="md" lh={1.1}>
                  {branding.name}
                </Text>
              </div>
            </UnstyledButton>
            <Group gap="xs" ml="auto" wrap="nowrap">
              <LocaleToggle />
              <ThemeToggle />
              <UserMenu
                email={viewer?.email ?? null}
                image={userImage}
                signInProviders={signInProviders}
              />
            </Group>
          </Group>
      </AppShell.Header>

      {/* Omit signed-out navigation from the DOM; CSS collapse alone is insufficient. */}
      <AppShell.Navbar className={classes.navbar} p="md">
        {showNav && (
        <>
        <ScrollArea viewportRef={navViewport} style={{ flex: 1 }} scrollbarSize={6} type="always">
          <Stack gap="md">
            {NAV_GROUPS.filter(visibleTo(viewer)).map((group) => (
              <Stack key={group.key} gap={2}>
                <Text fz={11} fw={600} c="dimmed" px="sm">
                  {t(group.label)}
                </Text>
                {group.items.map(navLink)}
              </Stack>
            ))}
          </Stack>
        </ScrollArea>
        <Stack gap={2} className={classes.navPersonal}>
          {PERSONAL_ITEMS.map(navLink)}
        </Stack>
        <div className={classes.navFooter}>
          <Text fz="xs" c="dimmed">
            {t("chrome.status", { version })}
          </Text>
        </div>
        </>
        )}
      </AppShell.Navbar>

      <AppShell.Main id="main-content" tabIndex={-1}>
        <div className={classes.main}>{children}</div>
      </AppShell.Main>
    </AppShell>
  );
}
