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

/**
 * How many chats a press asks for, and the first ask.
 *
 * The server has its own default and its own ceiling; this is the step the
 * sidebar takes, kept here because it is a property of this list rather than
 * of the endpoint.
 */
const PAGE = 50;

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
  /**
   * How many rows this sidebar is asking for.
   *
   * The endpoint is bounded now, and "show more" raises this rather than
   * carrying a cursor: the chat partition sorts on `updatedAt` alone, which
   * does not identify a row, so a cursor built from it would skip or repeat a
   * chat touched in the same millisecond as its neighbour. Re-reading the rows
   * it already had is the cheaper wrong thing, and it happens only when a
   * person presses the button.
   */
  const [limit, setLimit] = useState(PAGE);
  const [hasMore, setHasMore] = useState(false);
  const [drawerOpen, drawer] = useDisclosure(false);
  // Keys, not chat ids: a chat still being created counts under its placeholder,
  // so a first message refused before it learned its id still reloads this list
  // — the chat and its user turn are already on the server by then. Matching
  // chat ids below ignores the placeholders on its own.
  const running = useRunningKeys();

  const load = useCallback(async () => {
    const res = await fetch(`/api/chats?limit=${limit}`);
    if (res.ok) {
      const data = (await res.json()) as { chats?: Chat[]; hasMore?: boolean };
      setChats(data.chats ?? []);
      setHasMore(data.hasMore ?? false);
    }
    setLoaded(true);
  }, [limit]);

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
  useEffect(() => {
    void load();
  }, [load, running]);

  // A tap that opens a chat has done what the drawer was opened for. Depend on
  // the stable `close` callback, not the handlers object — useDisclosure
  // recreates that object every render, which made this effect close the
  // drawer on the very render that opened it.
  const closeDrawer = drawer.close;
  useEffect(() => {
    closeDrawer();
  }, [pathname, closeDrawer]);

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
        {hasMore && (
          <Button
            variant="subtle"
            size="compact-xs"
            mt="xs"
            onClick={() => setLimit((current) => current + PAGE)}
          >
            {t("chat.more")}
          </Button>
        )}
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
