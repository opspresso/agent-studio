"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  IconArrowRight,
  IconRobot,
  IconMessageCircle,
  IconPlus,
  IconSparkles,
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
  { key: "skills", href: "/skills", label: "nav.skills", url: "/api/skills" },
  { key: "tools", href: "/tools", label: "nav.tools", url: "/api/mcps" },
] as const satisfies ReadonlyArray<{
  key: string;
  href: string;
  label: MessageKey;
  url: string;
}>;

type CatalogKey = (typeof CATALOGS)[number]["key"];

/**
 * The signed-in home.
 *
 * The viewer arrives as props rather than through `useSession()`: the page is a
 * server component that has already awaited the session, so the first render
 * knows which catalog links are available and whose Agents are whose.
 */
export function Overview({
  userEmail,
  tier,
}: {
  userEmail: string;
  /**
   * Arrives as a prop for the same reason the email does: `useViewer()` answers
   * after hydration, so the catalogue links would render and then vanish for
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

  // Independently, so one unreachable registry costs its own count and no more.
  useEffect(() => {
    let cancelled = false;
    if (!showCatalogs) {
      // Not merely a hidden link: asking would be refused, and the
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
          // Left absent, so the link shows a dash rather than a zero.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [showCatalogs]);

  const recent = recentAgents(agents ?? [], viewerEmail, RECENT_AGENTS);
  // Only once both have answered, so the first-run panel never flashes over a
  // workspace that simply had not loaded yet.
  const isNewWorkspace =
    agentsLoaded && chatsLoaded && agents !== null && agents.length === 0 && !chatsFailed && chats.length === 0;

  return (
    <Stack gap={36}>
      <PageHeader title={t("overview.title")} description={t("overview.lede")}>
        <Button component={Link} href="/chats" leftSection={<IconMessageCircle size={16} />}>
          {t("overview.newChat")}
        </Button>
        <Button component={Link} href={canCreateAgents ? "/agents?create=1" : "/agents"}
          variant="default" leftSection={canCreateAgents ? <IconPlus size={16} /> : <IconRobot size={16} />}>
          {t(canCreateAgents ? "overview.newAgent" : "overview.allAgents")}
        </Button>
      </PageHeader>

      {isNewWorkspace ? (
        <GetStarted showCatalogs={showCatalogs} canCreateAgents={canCreateAgents} />
      ) : (
        <div className={classes.activityGrid}>
          <Section title={t("overview.recentChats")} description={t("overview.recentChatsNote")}
            href="/chats" linkLabel={t("overview.allChats")}>
            {!chatsLoaded && <RowSkeleton rows={4} />}
            {chatsLoaded && chatsFailed && <Alert color="red" variant="light">{t("overview.chatsFailed")}</Alert>}
            {chatsLoaded && !chatsFailed && chats.length === 0 && <EmptyLine>{t("overview.noChats")}</EmptyLine>}
            <div className={classes.chatList}>
              {chats.slice(0, RECENT_CHATS).map((chat) => (
                <UnstyledButton key={chat.chatId} component={Link} href={`/chats/${chat.chatId}`}
                  className={classes.chatRow}>
                  <div className={classes.chatRowMain}>
                    <span className={classes.kind}>{chat.workspaceId ? t("workspace.kind") : t("chat.kind")}</span>
                    <Text component="span" truncate>{chat.title}</Text>
                  </div>
                  <Text className={classes.rowMeta}>
                    {chat.agentName ? `${chat.agentName} · ` : ""}{formatDate(chat.updatedAt, locale)}
                  </Text>
                </UnstyledButton>
              ))}
            </div>
          </Section>

          <Section title={t("overview.recentAgents")} description={t("overview.recentAgentsNote")}
            href="/agents" linkLabel={t("overview.allAgents")}>
            {!agentsLoaded && <RowSkeleton rows={3} />}
            {agentsLoaded && agents === null && <Alert color="red" variant="light">{t("overview.agentsFailed")}</Alert>}
            {agentsLoaded && agents !== null && recent.length === 0 && <EmptyLine>{t("overview.noAgents")}</EmptyLine>}
            <div className={classes.agentList}>
              {recent.map((agent) => (
                <UnstyledButton key={agent.name} component={Link} href={`/agents/${agent.name}`}
                  className={classes.agentRow}>
                  <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Text fw={600} truncate>{agent.displayName || agent.name}</Text>
                    <IconArrowRight size={16} aria-hidden="true" />
                  </Group>
                  {agent.description && <Text className={classes.agentDescription} lineClamp={2}>{agent.description}</Text>}
                  <Text className={classes.rowMeta} ff="monospace">{agent.name}</Text>
                  {viewerEmail !== agent.ownerEmail && (
                    <OwnerLine ownerEmail={agent.ownerEmail} isMine={false} mt={4} />
                  )}
                </UnstyledButton>
              ))}
            </div>
          </Section>
        </div>
      )}

      <nav aria-label={t("overview.inventory")} className={classes.inventory}>
        <Text className={classes.inventoryLabel}>{t("overview.inventory")}</Text>
        <div className={classes.inventoryLinks}>
          <Link href="/agents"><span>{t("nav.agents")}</span><strong>{agents?.length ?? "—"}</strong></Link>
          {showCatalogs && CATALOGS.map(({ key, href, label }) => (
            <Link href={href} key={key}><span>{t(label)}</span><strong>{counts[key] ?? "—"}</strong></Link>
          ))}
        </div>
      </nav>

      <div className={classes.usageSection}><Dashboard agents={agents} /></div>
    </Stack>
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
          <Title order={2} fz="xl" fw={650}>{title}</Title>
          <Text fz="sm" c="dimmed" mt={4}>
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
