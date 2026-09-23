"use client";

import Link from "next/link";
import { ActionIcon, Loader, Stack, UnstyledButton } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import type { Chat } from "@/domain/chat/types";
import classes from "./ChatSidebar.module.css";

export type SidebarTab = "chats" | "workspaces";

export function ChatSidebarItems({ chats, tab, activeId, running, onDelete }: {
  chats: Chat[];
  tab: SidebarTab;
  activeId?: string;
  running: readonly string[];
  onDelete: (chatId: string) => void;
}) {
  const t = useT();
  const workspace = tab === "workspaces";
  return <Stack gap={2}>
    {chats.map(chat =>
      <div key={chat.chatId} className={classes.row} data-active={chat.chatId === activeId || undefined}>
        <UnstyledButton component={Link} href={`/chats/${chat.chatId}`} fz="sm" className={classes.title}
          title={chat.title} aria-current={chat.chatId === activeId ? "page" : undefined}>
          {chat.title}
        </UnstyledButton>
        {running.includes(chat.chatId) && <Loader size={10} />}
        <ActionIcon size="sm" variant="subtle" color="red" className={classes.delete}
          onClick={() => onDelete(chat.chatId)} aria-label={t(workspace ? "workspace.delete" : "chat.delete")}>
          <IconX size={14} />
        </ActionIcon>
      </div>)}
  </Stack>;
}
