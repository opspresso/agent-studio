"use client";
import { WORKSPACE_ACTIVITY_EVENT } from "@/app/workspaces/_lib/activity";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Group,
  ScrollArea,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useDisclosure, useLocalStorage } from "@mantine/hooks";
import { IconMessages, IconPlus, IconTerminal2 } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { CHAT_PAGE } from "@/domain/chat/repository";
import type { ChatListResponse } from "@/app/api/chats/route";
import type { Chat } from "../_lib/types";
import { useRunningKeys } from "../_lib/runHooks";
import { runStore } from "../_lib/runStore";
import { ChatSidebarItems, type SidebarTab } from "./ChatSidebarItems";
import { readJson } from "@/app/_lib/httpClient";
import classes from "./ChatSidebar.module.css";

const NEW_CHAT_EVENT = "chats:new";
const SIDEBAR_TAB_KEY = "agent-studio-chat-sidebar-tab";
type SidebarPage = { chats: Chat[]; loaded: boolean; hasMore: boolean; limit: number; error: string | null };

/** Subscribe to the "New chat" press. The button routes to /chats, but a panel
 * that swapped the URL to /chats/<id> without a route change is already that
 * segment — the router keeps it mounted, so the navigation alone resets
 * nothing and the finished thread stays on screen. */
export function onNewChat(handler: () => void): () => void {
  window.addEventListener(NEW_CHAT_EVENT, handler);
  return () => window.removeEventListener(NEW_CHAT_EVENT, handler);
}

export function ChatSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const t = useT();
  /**
   * Each tab pages its own owner partition subset. "Show more" raises that
   * tab's limit and rereads its rows because updatedAt alone is not a cursor.
   *
   * A single global limit followed by client filtering could hide every
   * Workspace behind newer Chats, even at the endpoint's maximum page size.
   */
  const [pages, setPages] = useState<Record<SidebarTab, SidebarPage>>({
    chats: { chats: [], loaded: false, hasMore: false, limit: CHAT_PAGE, error: null },
    workspaces: { chats: [], loaded: false, hasMore: false, limit: CHAT_PAGE, error: null },
  });
  const [tab, setTab] = useLocalStorage<SidebarTab>({
    key: SIDEBAR_TAB_KEY,
    defaultValue: "chats",
    deserialize: value => value === '"workspaces"' ? "workspaces" : "chats",
    sync: false,
  });
  const [drawerOpen, drawer] = useDisclosure(false);
  /** A stale read may only replace rows from the same tab. */
  const loadSeq = useRef<Record<SidebarTab, number>>({ chats: 0, workspaces: 0 });
  // Keys, not chat ids: a chat still being created counts under its placeholder,
  // so a first message refused before it learned its id still reloads this list
  // — the chat and its user turn are already on the server by then. Matching
  // chat ids below ignores the placeholders on its own.
  const running = useRunningKeys();

  const load = useCallback(async (kind: SidebarTab, limit: number) => {
    // Ticketed like the thread's own sync. Two reads are in flight whenever
    // "show more" is pressed while a run start is reloading the list, and the
    // smaller one landing last would put the list back to a page the reader
    // has already grown past — while `limit` stayed raised, so the next press
    // would skip a page rather than repeat one.
    const ticket = ++loadSeq.current[kind];
    try {
      const res = await fetch(`/api/chats?kind=${kind === "chats" ? "chat" : "workspace"}&limit=${limit}`);
      const data = await readJson<ChatListResponse>(res);
      if (ticket !== loadSeq.current[kind]) {
        return;
      }
      setPages(current => current[kind].limit !== limit ? current : {
        ...current,
        [kind]: { ...current[kind], chats: data.chats ?? [], hasMore: data.hasMore ?? false, loaded: true, error: null },
      });
    } catch (error) {
      // Keep the last good rows and show why this read could not refresh them.
      if (ticket !== loadSeq.current[kind]) return;
      setPages(current => current[kind].limit !== limit ? current : {
        ...current,
        [kind]: { ...current[kind], loaded: true, error: error instanceof Error ? error.message : "Failed to load chats" },
      });
    }
  }, []);

  // Reloads when a run starts or ends, because the running set only changes
  // then. The sidebar is mounted for the whole `/chats` segment, which is why it
  // is the right place to notice: a run can now finish with no thread on screen,
  // and a view that told the sidebar itself would never fire.
  //
  // Deliberately *not* on `pathname`. Opening a chat changes which row is
  // highlighted, which this component works out from the path without asking
  // the server anything — and a chat that appears while reading is a chat whose
  // run started, which the running set already reports. Reloading on every
  // navigation meant a third full read of the list per turn.
  const limit = pages[tab].limit;
  useEffect(() => {
    void load(tab, limit);
  }, [load, tab, limit, running]);
  useEffect(() => {
    const refresh = () => { void load(tab, limit); };
    window.addEventListener(WORKSPACE_ACTIVITY_EVENT, refresh);
    return () => window.removeEventListener(WORKSPACE_ACTIVITY_EVENT, refresh);
  }, [load, tab, limit]);

  // A tap that opens a chat has done what the drawer was opened for. Depend on
  // the stable `close` callback, not the handlers object — useDisclosure
  // recreates that object every render, which made this effect close the
  // drawer on the very render that opened it.
  const closeDrawer = drawer.close;
  useEffect(() => {
    closeDrawer();
  }, [pathname, closeDrawer]);

  const activeId = pathname.startsWith("/chats/") ? pathname.split("/")[2] : undefined;
  const activeChat = pages.chats.chats.find(chat => chat.chatId === activeId) ??
    pages.workspaces.chats.find(chat => chat.chatId === activeId);
  const activeTab: SidebarTab | undefined = activeChat ? activeChat.workspaceId ? "workspaces" : "chats" : undefined;
  const currentTitle = activeChat ? t("chat.currentItem", { title: activeChat.title }) : undefined;

  async function handleDelete(chatId: string) {
    const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
    if (res.ok) {
      // Otherwise its stream keeps reading rows that no longer exist.
      runStore.abort(chatId);
      await load(tab, limit);
      if (activeId === chatId) {
        router.push("/chats");
      }
    }
  }

  const newChat = (
    <Button
      component={Link}
      href="/chats"
      onClick={() => window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT))}
      radius="xl"
      leftSection={<IconPlus size={16} />}
    >
      {t("chat.new")}
    </Button>
  );

  const listFor = (kind: SidebarTab) => (
    <ScrollArea h="100%" scrollbarSize={6} pr={4}>
      <Stack gap={2}>
        {pages[kind].error && <Alert color="red" variant="light" p="xs">
          <Stack gap="xs">
            <Text fz="xs">{pages[kind].error}</Text>
            <Button variant="light" size="compact-xs" onClick={() => void load(kind, pages[kind].limit)}>
              {t("error.retry")}
            </Button>
          </Stack>
        </Alert>}
        {pages[kind].loaded && !pages[kind].error && !pages[kind].hasMore && pages[kind].chats.length === 0 && (
          <Text fz="xs" c="dimmed" px="xs" py="md">
            {t(kind === "workspaces" ? "workspace.none" : "chat.none")}
          </Text>
        )}
        <ChatSidebarItems chats={pages[kind].chats} tab={kind} activeId={activeId} running={running} onDelete={chatId => void handleDelete(chatId)} />
        {pages[kind].hasMore && (
          <Button variant="subtle" size="compact-xs" mt="xs" onClick={() => setPages(current => ({
            ...current, [kind]: { ...current[kind], limit: current[kind].limit + CHAT_PAGE },
          }))}>
            {t("chat.more")}
          </Button>
        )}
      </Stack>
    </ScrollArea>
  );
  const list = (
    <Tabs value={tab} onChange={value => { if (value === "chats" || value === "workspaces") setTab(value); }}
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Tabs.List grow>
        <Tabs.Tab value="chats" leftSection={<IconMessages size={15} />} className={classes.tab}
          data-current={activeTab === "chats" || undefined} title={activeTab === "chats" ? currentTitle : undefined}
          aria-description={activeTab === "chats" ? currentTitle : undefined}>{t("chat.list")}</Tabs.Tab>
        <Tabs.Tab value="workspaces" leftSection={<IconTerminal2 size={15} />} className={classes.tab}
          data-current={activeTab === "workspaces" || undefined} title={activeTab === "workspaces" ? currentTitle : undefined}
          aria-description={activeTab === "workspaces" ? currentTitle : undefined}>{t("workspace.list")}</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="chats" pt="xs" style={{ flex: 1, minHeight: 0 }}>{listFor("chats")}</Tabs.Panel>
      <Tabs.Panel value="workspaces" pt="xs" style={{ flex: 1, minHeight: 0 }}>{listFor("workspaces")}</Tabs.Panel>
    </Tabs>
  );

  return (
    <>
      {/* Desktop: a column beside the thread. */}
      <Stack component="aside" gap="sm" className={classes.sidebar} visibleFrom="md">
        {newChat}
        {list}
      </Stack>

      {/*
       * Narrow: a drawer, not a squashed column. A list above the thread steals
       * conversation space as it grows while still showing only a few chats.
       */}
      <Group gap="xs" hiddenFrom="md" wrap="nowrap">
        <Button
          variant="default"
          radius="xl"
          leftSection={<IconMessages size={16} />}
          onClick={drawer.open}
        >
          {t("chat.history")}
        </Button>
        {newChat}
      </Group>
      {/* No `hiddenFrom` needed: the only thing that opens it is hidden there. */}
      <Drawer opened={drawerOpen} onClose={drawer.close} title={t("chat.history")} size="80%">
        <Stack gap="sm" h="100%">
          {list}
        </Stack>
      </Drawer>
    </>
  );
}
