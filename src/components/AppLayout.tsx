"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ActionIcon,
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
  IconFolder,
  IconMessageCircle,
  IconPhoto,
  IconPackage,
  IconPlus,
  IconRobot,
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
import type { SignInProviders } from "./SignInButton";
import { LocaleToggle } from "./LocaleToggle";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import classes from "./AppLayout.module.css";

/*
 * Labels are message keys, resolved at render. `key` is separate from `label`
 * because the admin-only filter below keys on the group's identity, and a
 * translated string is not one — matching on `"System"` would have stopped
 * matching the moment the sidebar spoke Korean, silently showing every reader
 * the admin section.
 *
 * `satisfies` rather than a bare `as const`: it is what makes a mistyped key a
 * compile error here instead of an English fallback at render.
 */
const NAV_GROUPS = [
  {
    key: "workspace",
    label: "nav.group.workspace",
    items: [
      { href: "/", label: "nav.overview", Icon: IconChartBar },
      { href: "/projects", label: "nav.projects", Icon: IconFolder },
      { href: "/chats", label: "nav.chats", Icon: IconMessageCircle },
      { href: "/artifacts", label: "nav.artifacts", Icon: IconPhoto },
    ],
  },
  {
    key: "intelligence",
    label: "nav.group.intelligence",
    // The registries a version draws on, in the order a version binds them:
    // skills and MCP tools first, then the agents it can hand work to, then
    // the models it may run on. `Plugins` is last because it is the *source*
    // that fills the first two rather than a catalogue of its own — the model
    // registry is a catalogue of what this deployment can reach, read from the
    // member rung; only the toggles and the probe on it stay admin's.
    items: [
      { href: "/skills", label: "nav.skills", Icon: IconBook2 },
      { href: "/tools", label: "nav.tools", Icon: IconTool },
      { href: "/agents", label: "nav.agents", Icon: IconRobot },
      { href: "/models", label: "nav.models", Icon: IconCpu },
      { href: "/plugins", label: "nav.plugins", Icon: IconPackage },
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
 * The reader's own two pages, kept out of the groups above and pinned to the
 * foot of the sidebar.
 *
 * Neither is a thing the workspace holds: one is the account looking at it and
 * the other is how to use it. Sitting in the workspace group they pushed the
 * registries down and read as more work to do. The profile link stays here
 * rather than moving into the header entirely, because the header's own link
 * to it is `visibleFrom="lg"` and would disappear on a laptop.
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
  version,
  viewer,
  signInProviders,
  children,
}: {
  version: string;
  /** Resolved by the root layout; `null` when nobody is signed in. */
  viewer: Viewer | null;
  /** What the header's sign-in control offers a signed-out visitor. */
  signInProviders: SignInProviders;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const t = useT();
  const [opened, { toggle, close }] = useDisclosure(false);

  /*
   * Every nav target is behind the sign-in gate, so offering them to a
   * signed-out visitor is a row of links that only bounce back to /login.
   *
   * This is a prop rather than `useSession()` because the answer has to be the
   * same on both sides of hydration: the hook has no cookie during SSR, so it
   * said `isPending`, the server drew the whole nav for everyone, and a
   * signed-out visitor watched it vanish. The root layout says why.
   */
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
          variant={active ? "gradient" : "transparent"}
          gradient={{ from: "brand.6", to: "violet.5", deg: 135 }}
          color={active ? undefined : "gray"}
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
        width: 248,
        breakpoint: "md",
        collapsed: { mobile: !opened || !showNav, desktop: !showNav },
      }}
      padding={0}
    >
      <AppShell.Header className={classes.header}>
        <Group h="100%" gap="md" wrap="nowrap" px={{ base: "md", md: "lg" }}>
            {showNav && (
              <Burger opened={opened} onClick={toggle} hiddenFrom="md" size="sm" />
            )}
            <UnstyledButton component={Link} href="/" className={classes.brand}>
              <span className={classes.logoWrap}>
                <Image src="/logo.png" alt="" width={28} height={28} priority />
              </span>
              <div>
                <Text fw={650} fz="md" lh={1.1}>
                  Agent Studio
                </Text>
                <Text fz={10} c="dimmed" tt="uppercase" lts="0.12em" visibleFrom="xs">
                  {t("chrome.tagline")}
                </Text>
              </div>
            </UnstyledButton>
            <Group gap="xs" ml="auto" wrap="nowrap">
              <LocaleToggle />
              <ThemeToggle />
              <UserMenu email={viewer?.email ?? null} signInProviders={signInProviders} />
            </Group>
          </Group>
      </AppShell.Header>

      {/*
       * Collapsing it is not enough: a collapsed navbar is still in the
       * document, so a signed-out visitor was shipped every link in the studio
       * and only CSS kept them out of sight. `src/proxy.ts` turns that visitor
       * away precisely so the shape of the workspace does not reach them.
       */}
      <AppShell.Navbar className={classes.navbar} p="md">
        {showNav && (
        <>
        <Group justify="space-between" mb="lg">
          <Text fz={10} fw={600} c="dimmed" tt="uppercase" lts="0.14em">
            {t("chrome.navLabel")}
          </Text>
          <ActionIcon
            component={Link}
            href="/projects"
            variant="light"
            color="brand"
            size="sm"
            aria-label={t("chrome.openProjects")}
            onClick={close}
          >
            <IconPlus size={14} />
          </ActionIcon>
        </Group>
        <ScrollArea style={{ flex: 1 }} scrollbarSize={4}>
          <Stack gap="xl">
            {NAV_GROUPS.filter(visibleTo(viewer)).map((group) => (
              <Stack key={group.key} gap={6}>
                <Text fz={10} fw={600} c="dimmed" tt="uppercase" lts="0.12em" px="sm">
                  {t(group.label)}
                </Text>
                {group.items.map(navLink)}
              </Stack>
            ))}
          </Stack>
        </ScrollArea>
        <Stack gap={6} className={classes.navPersonal}>
          {PERSONAL_ITEMS.map(navLink)}
        </Stack>
        <div className={classes.navFooter}>
          <span className={classes.statusDot} />
          <Text fz="xs" c="dimmed">
            {t("chrome.status", { version })}
          </Text>
        </div>
        </>
        )}
      </AppShell.Navbar>

      <AppShell.Main>
        <main className={classes.main} id="main-content">
          {children}
        </main>
      </AppShell.Main>
    </AppShell>
  );
}
