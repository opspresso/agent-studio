"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowRight,
  IconBook2,
  IconRobot,
  IconMessageCircle,
  IconPlus,
  IconSparkles,
  IconTool,
} from "@tabler/icons-react";
import { readJson } from "@/app/_lib/httpClient";
import { recentAgents } from "@/app/_lib/overview";
import type { Chat } from "@/domain/chat/types";
import { listAgents, type SanitizedAgent } from "@/app/agents/lib/api";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useLocale, useT } from "@/app/_i18n/provider";
import { tierAtLeast, tierMayCreateAgents, type MemberTier } from "@/domain/member/tiers";
import { formatDate } from "@/shared/date";
import { OwnerLine } from "./OwnerLine";
import { PageHeader } from "./PageHeader";
import { Dashboard } from "./Dashboard";
import classes from "./Overview.module.css";

/** A chat as the list endpoint returns it. Newest first, per `listChats`. */
type ChatSummary = Pick<Chat, "chatId" | "title" | "agentName" | "updatedAt" | "workspaceId">;

const RECENT_AGENTS = 4;
const RECENT_CHATS = 7;

/**
 * The catalogs whose size the summary reports. Each is counted from the list
 * endpoint the catalog page itself reads — no count endpoint exists, and these
 * are bounded registries rather than growing tables.
 */
const CATALOGS = [
  { key: "skills", href: "/skills", label: "nav.skills", url: "/api/skills", Icon: IconBook2 },
  { key: "tools", href: "/tools", label: "nav.tools", url: "/api/mcps", Icon: IconTool },
] as const satisfies ReadonlyArray<{
  key: string;
  href: string;
  label: MessageKey;
  url: string;
  Icon: typeof IconBook2;
}>;

type CatalogKey = (typeof CATALOGS)[number]["key"];

/**
 * The signed-in home.
 *
 * The viewer arrives as props rather than through `useSession()`: the page is a
 * server component that has already awaited the session, and a hook that
 * resolves after hydration renders a different greeting than the server sent —
 * which is a hydration mismatch, not a flicker. It also means the first render
 * already knows whose agents are whose.
 */
export function Overview({
  userName,
  userEmail,
  tier,
}: {
  userName: string;
  userEmail: string;
  /**
   * Arrives as a prop for the same reason the email does: `useViewer()` answers
   * after hydration, so the catalogue tiles would render and then vanish for
   * the one reader who is not allowed to see they exist.
   */
  tier: MemberTier;
}) {
  const viewerEmail = userEmail;
  const showCatalogs = tierAtLeast(tier, "member");
  const canCreateAgents = tierMayCreateAgents(tier);
  const t = useT();
  const locale = useLocale();

  const [agents, setAgents] = useState<SanitizedAgent[] | null>(null);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatsFailed, setChatsFailed] = useState(false);
  /**
   * One entry per catalog, absent until it answers. A count that failed stays
   * absent and renders as a dash: a catalog nobody could read must not be shown
   * as an empty one.
   */
  const [counts, setCounts] = useState<Partial<Record<CatalogKey, number>>>({});

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((loaded) => {
        if (!cancelled) {
          setAgents(loaded);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgents(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAgentsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/chats?limit=${RECENT_CHATS}`)
      .then((res) => readJson<{ chats?: ChatSummary[] }>(res))
      .then((data) => {
        if (!cancelled) {
          setChats(data.chats ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setChatsFailed(true);
      })
      .finally(() => {
        if (!cancelled) {
          setChatsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Independently, so one unreachable registry costs its own tile and no more.
  useEffect(() => {
    let cancelled = false;
    if (!showCatalogs) {
      // Not merely a hidden tile: asking would be three 403s per visit, and the
      // count is the fact being withheld.
      return;
    }
    for (const catalog of CATALOGS) {
      fetch(catalog.url)
        .then((res) => readJson<unknown[]>(res))
        .then((entries) => {
          if (!cancelled) {
            setCounts((current) => ({ ...current, [catalog.key]: entries.length }));
          }
        })
        .catch(() => {
          // Left absent, so the tile shows a dash rather than a zero.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [showCatalogs]);

  const recent = recentAgents(agents ?? [], viewerEmail, RECENT_AGENTS);
  const firstName = userName.split(" ")[0];
  // Only once both have answered, so the first-run panel never flashes over a
  // workspace that simply had not loaded yet.
  const isNewWorkspace =
    agentsLoaded && chatsLoaded && agents !== null && agents.length === 0 && !chatsFailed && chats.length === 0;

  return (
    <Stack gap={32}>
      <PageHeader title={firstName ? t("overview.welcome", { name: firstName }) : t("overview.welcomeAnon")} description={t("overview.lede")} Icon={IconSparkles}>
          <Button component={Link} href={canCreateAgents ? "/agents?create=1" : "/agents"} leftSection={canCreateAgents ? <IconPlus size={16} /> : <IconRobot size={16} />}>
            {t(canCreateAgents ? "overview.newAgent" : "overview.allAgents")}
          </Button>
          <Button
            component={Link}
            href="/chats"
            variant="default"
            leftSection={<IconMessageCircle size={16} />}
          >
            {t("overview.newChat")}
          </Button>
      </PageHeader>

      {isNewWorkspace ? (
        <GetStarted showCatalogs={showCatalogs} canCreateAgents={canCreateAgents} />
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg" style={{ alignItems: "start" }}>
          <Section
            title={t("overview.recentAgents")}
            description={t("overview.recentAgentsNote")}
            href="/agents"
            linkLabel={t("overview.allAgents")}
          >
            {!agentsLoaded && <RowSkeleton rows={3} />}
            {agentsLoaded && agents === null && (
              <Alert color="red" variant="light">
                {t("overview.agentsFailed")}
              </Alert>
            )}
            {agentsLoaded && agents !== null && recent.length === 0 && (
              <EmptyLine>{t("overview.noAgents")}</EmptyLine>
            )}
            <Stack gap="sm">
              {recent.map((agent) => (
                <Card key={agent.name} component={Link} href={`/agents/${agent.name}`} padding="sm" className={classes.agentRow}>
                  <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Text fw={500} truncate>
                      {agent.displayName || agent.name}
                    </Text>
                  </Group>
                  <Text ff="monospace" fz="xs" c="dimmed" mt={2}>
                    {agent.name}
                  </Text>
                  <OwnerLine
                    ownerEmail={agent.ownerEmail}
                    isMine={viewerEmail === agent.ownerEmail}
                    mt={6}
                  />
                </Card>
              ))}
            </Stack>
          </Section>

          <Section
            title={t("overview.recentChats")}
            description={t("overview.recentChatsNote")}
            href="/chats"
            linkLabel={t("overview.allChats")}
          >
            {!chatsLoaded && <RowSkeleton rows={3} />}
            {chatsLoaded && chatsFailed && <Alert color="red" variant="light">{t("overview.chatsFailed")}</Alert>}
            {chatsLoaded && !chatsFailed && chats.length === 0 && <EmptyLine>{t("overview.noChats")}</EmptyLine>}
            <Stack gap={2}>
              {chats.slice(0, RECENT_CHATS).map((chat) => (
                <UnstyledButton
                  key={chat.chatId}
                  component={Link}
                  href={`/chats/${chat.chatId}`}
                  className={classes.chatRow}
                >
                  <Group gap="xs" wrap="nowrap">
                    <Badge size="xs" variant="light">{chat.workspaceId ? t("workspace.kind") : t("chat.kind")}</Badge>
                    <Text fz="sm" truncate>{chat.title}</Text>
                  </Group>
                  <Text fz="xs" c="dimmed" mt={2}>
                    {chat.agentName ? `${chat.agentName} · ` : ""}
                    {formatDate(chat.updatedAt, locale)}
                  </Text>
                </UnstyledButton>
              ))}
            </Stack>
          </Section>
        </SimpleGrid>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, md: showCatalogs ? 3 : 1 }} spacing="md">
        <CountTile
          href="/agents"
          label={t("nav.agents")}
          count={agents?.length}
          Icon={IconRobot}
        />
        {showCatalogs &&
          CATALOGS.map(({ key, href, label, Icon }) => (
            <CountTile key={key} href={href} label={t(label)} count={counts[key]} Icon={Icon} />
          ))}
      </SimpleGrid>

      <Dashboard agents={agents} />
    </Stack>
  );
}

function CountTile({
  href,
  label,
  count,
  Icon,
}: {
  href: string;
  label: string;
  /** Absent while loading, and after a failed read. */
  count?: number;
  Icon: typeof IconRobot;
}) {
  return (
    <Card component={Link} href={href} padding="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text fz="sm" fw={500} c="dimmed">
            {label}
          </Text>
          <Text fz={24} fw={600} mt={4} lts="-0.035em">
            {count ?? "—"}
          </Text>
        </div>
        <ThemeIcon variant="light" color="brand" size={34} radius="lg">
          <Icon size={18} stroke={1.7} />
        </ThemeIcon>
      </Group>
    </Card>
  );
}

function Section({
  title,
  description,
  href,
  linkLabel,
  children,
}: {
  title: string;
  description: string;
  href: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="md" component="section" className={classes.section}>
      <Group justify="space-between" align="flex-end" gap="xs" wrap="wrap">
        <div>
          <Title order={2} fz="md" fw={600}>{title}</Title>
          <Text fz="xs" c="dimmed">
            {description}
          </Text>
        </div>
        <Anchor component={Link} href={href} fz="sm" style={{ whiteSpace: "nowrap" }}>
          <Group gap={4} wrap="nowrap">
            {linkLabel}
            <IconArrowRight size={14} />
          </Group>
        </Anchor>
      </Group>
      {children}
    </Stack>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <Text fz="sm" c="dimmed" py="md">
      {children}
    </Text>
  );
}

function RowSkeleton({ rows }: { rows: number }) {
  const t = useT();
  return (
    <Stack gap="sm" aria-label={t("common.loading")}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={54} radius="lg" />
      ))}
    </Stack>
  );
}

/**
 * The first-run panel. One panel rather than an empty one per section: a new
 * workspace showing three "nothing here" boxes says what is missing and never
 * what to do about it.
 */
function GetStarted({ showCatalogs, canCreateAgents }: { showCatalogs: boolean; canCreateAgents: boolean }) {
  const t = useT();
  return (
    <Paper withBorder p="xl" className={classes.getStarted}>
      <Group gap="md" align="flex-start" wrap="nowrap">
        <ThemeIcon variant="light" color="brand" size={44} radius="lg">
          <IconSparkles size={22} stroke={1.7} />
        </ThemeIcon>
        <Stack gap="xs">
          <Text fw={600}>{t("overview.getStarted")}</Text>
          <Text fz="sm" c="dimmed" maw={560} lh={1.6}>
            {t("overview.getStartedBody")}
          </Text>
          <Group gap="xs" mt={4}>
            <Button component={Link} href={canCreateAgents ? "/agents?create=1" : "/agents"} leftSection={canCreateAgents ? <IconPlus size={16} /> : <IconRobot size={16} />}>
              {t(canCreateAgents ? "overview.newAgent" : "overview.allAgents")}
            </Button>
            {showCatalogs && (
              <Button component={Link} href="/skills" variant="default">
                {t("overview.browseSkills")}
              </Button>
            )}
          </Group>
        </Stack>
      </Group>
    </Paper>
  );
}
