"use client";

import Link from "next/link";
import { ActionIcon, Loader, Stack, UnstyledButton } from "@mantine/core";
import { IconMessages, IconTerminal2, IconX } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import type { Chat } from "@/domain/chat/types";
import classes from "./ChatSidebar.module.css";

export function ChatSidebarItems({ chats, activeId, running, onDelete }: {
  chats: Chat[];
  activeId?: string;
  running: readonly string[];
  onDelete: (chatId: string) => void;
}) {
  const t = useT();
  return <>{[true, false].map(workspace => {
    const items = chats.filter(chat => Boolean(chat.workspaceId) === workspace);
    if (!items.length) return null;
    const label = t(workspace ? "workspace.list" : "chat.list");
    const Icon = workspace ? IconTerminal2 : IconMessages;
    return <details key={String(workspace)} open className={classes.section} aria-label={label}>
      <summary className={classes.sectionTitle}><Icon size={15} aria-hidden /><span>{label}</span></summary>
      <Stack gap={2}>
        {items.map(chat => <div key={chat.chatId} className={classes.row} data-active={chat.chatId === activeId || undefined}>
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
      </Stack>
    </details>;
  })}</>;
}
