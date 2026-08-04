"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Button, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import type { Chat } from "../_lib/types";
import classes from "./ChatSidebar.module.css";

const REFRESH_EVENT = "chats:refresh";
const NEW_CHAT_EVENT = "chats:new";

export function refreshChats() {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

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
  const [chats, setChats] = useState<Chat[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/chats");
    if (res.ok) {
      const data = (await res.json()) as { chats?: Chat[] };
      setChats(data.chats ?? []);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load, pathname]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(REFRESH_EVENT, handler);
    return () => window.removeEventListener(REFRESH_EVENT, handler);
  }, [load]);

  const activeId = pathname.startsWith("/chats/") ? pathname.split("/")[2] : undefined;

  async function handleDelete(chatId: string) {
    const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
    if (res.ok) {
      await load();
      if (activeId === chatId) {
        router.push("/chats");
      }
    }
  }

  return (
    <Stack component="aside" gap="sm" className={classes.sidebar}>
      <Button
        component={Link}
        href="/chats"
        onClick={() => window.dispatchEvent(new CustomEvent(NEW_CHAT_EVENT))}
        radius="xl"
        leftSection={<IconPlus size={16} />}
      >
        New chat
      </Button>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} scrollbarSize={6} pr={4}>
        <Stack gap={2}>
          {loaded && chats.length === 0 && (
            <Text fz="xs" c="dimmed" px="xs" py="md">
              No chats yet.
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
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                className={classes.delete}
                onClick={() => void handleDelete(chat.chatId)}
                aria-label="Delete chat"
              >
                <IconX size={14} />
              </ActionIcon>
            </div>
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
