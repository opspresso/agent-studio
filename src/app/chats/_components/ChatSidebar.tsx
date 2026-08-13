"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Button,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconMessages, IconPlus, IconX } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import type { Chat } from "../_lib/types";
import { useRunningKeys } from "../_lib/runHooks";
import { runStore } from "../_lib/runStore";
import classes from "./ChatSidebar.module.css";

const NEW_CHAT_EVENT = "chats:new";

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
  const [chats, setChats] = useState<Chat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [drawerOpen, drawer] = useDisclosure(false);
  // Keys, not chat ids: a chat still being created counts under its placeholder,
  // so a first message refused before it learned its id still reloads this list
  // — the chat and its user turn are already on the server by then. Matching
  // chat ids below ignores the placeholders on its own.
  const running = useRunningKeys();

  const load = useCallback(async () => {
    const res = await fetch("/api/chats");
    if (res.ok) {
      const data = (await res.json()) as { chats?: Chat[] };
      setChats(data.chats ?? []);
    }
    setLoaded(true);
  }, []);

  // Reloads when a run starts or ends, because the running set only changes
  // then. The sidebar is mounted for the whole `/chats` segment, which is why it
  // is the right place to notice: a run can now finish with no thread on screen,
  // and a view that told the sidebar itself would never fire.
  useEffect(() => {
    void load();
  }, [load, pathname, running]);

  // A tap that opens a chat has done what the drawer was opened for.
  useEffect(() => {
    drawer.close();
  }, [pathname, drawer]);

  const activeId = pathname.startsWith("/chats/") ? pathname.split("/")[2] : undefined;

  async function handleDelete(chatId: string) {
    const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
    if (res.ok) {
      // Otherwise its stream keeps reading rows that no longer exist.
      runStore.abort(chatId);
      await load();
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

  const list = (
    <ScrollArea style={{ flex: 1, minHeight: 0 }} scrollbarSize={6} pr={4}>
      <Stack gap={2}>
        {loaded && chats.length === 0 && (
          <Text fz="xs" c="dimmed" px="xs" py="md">
            {t("chat.none")}
          </Text>
        )}
        {chats.map((chat) => (
          <div
            key={chat.chatId}
            className={classes.row}
            data-active={chat.chatId === activeId || undefined}
          >
            <UnstyledButton
              component={Link}
              href={`/chats/${chat.chatId}`}
              fz="sm"
              className={classes.title}
            >
              {chat.title}
            </UnstyledButton>
            {running.includes(chat.chatId) && <Loader size={10} />}
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              className={classes.delete}
              onClick={() => void handleDelete(chat.chatId)}
              aria-label={t("chat.delete")}
            >
              <IconX size={14} />
            </ActionIcon>
          </div>
        ))}
      </Stack>
    </ScrollArea>
  );

  return (
    <>
      {/* Desktop: a column beside the thread. */}
      <Stack component="aside" gap="sm" className={classes.sidebar} visibleFrom="md">
        {newChat}
        {list}
      </Stack>

      {/*
       * Narrow: a drawer, not a squashed column. The list used to sit above the
       * thread capped at ten rems, which gave the conversation less room the
       * more chats there were and still showed only three of them.
       */}
      <Group gap="xs" hiddenFrom="md" wrap="nowrap">
        <Button
          variant="default"
          radius="xl"
          leftSection={<IconMessages size={16} />}
          onClick={drawer.open}
        >
          {t("chat.list")}
        </Button>
        {newChat}
      </Group>
      {/* No `hiddenFrom` needed: the only thing that opens it is hidden there. */}
      <Drawer opened={drawerOpen} onClose={drawer.close} title={t("chat.list")} size="80%">
        <Stack gap="sm" h="100%">
          {list}
        </Stack>
      </Drawer>
    </>
  );
}
