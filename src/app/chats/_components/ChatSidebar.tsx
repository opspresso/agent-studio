"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Chat } from "../_lib/types";

const REFRESH_EVENT = "chats:refresh";

export function refreshChats() {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
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
    <aside className="flex max-h-40 w-full shrink-0 flex-col gap-3 overflow-hidden md:max-h-none md:w-64">
      <Link
        href="/chats"
        className="rounded-xl bg-brand px-3 py-2 text-center text-sm font-medium text-white hover:bg-brand-strong"
      >
        + New chat
      </Link>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {loaded && chats.length === 0 && (
          <p className="px-2 py-4 text-xs text-neutral-500">No chats yet.</p>
        )}
        {chats.map((chat) => {
          const active = chat.chatId === activeId;
          return (
            <div
              key={chat.chatId}
              className={`group flex items-center gap-1 rounded-lg px-2 py-2 text-sm ${
                active
                  ? "bg-neutral-200 dark:bg-neutral-800"
                  : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              <Link href={`/chats/${chat.chatId}`} className="min-w-0 flex-1 truncate">
                {chat.title}
              </Link>
              <button
                type="button"
                onClick={() => void handleDelete(chat.chatId)}
                aria-label="Delete chat"
                className="shrink-0 rounded px-1 text-xs text-neutral-400 opacity-0 hover:text-red-500 group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
