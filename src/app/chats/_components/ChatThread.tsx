"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readSse } from "../_lib/sseClient";
import { reduceChunk } from "../_lib/stream";
import { EMPTY_TURN, type ChatMessage, type LiveTurn } from "../_lib/types";
import { Composer, LiveAssistant, MessageView } from "./parts";
import { refreshChats } from "./ChatSidebar";

export function ChatThread({ chatId }: { chatId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "not-found">("loading");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/chats/${chatId}`);
    if (res.status === 404) {
      setStatus("not-found");
      return;
    }
    if (res.ok) {
      const data = (await res.json()) as { messages?: ChatMessage[] };
      setMessages(data.messages ?? []);
      setStatus("ready");
    }
  }, [chatId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, pendingUser]);

  async function handleSend(content: string) {
    setSending(true);
    setError(null);
    setPendingUser(content);
    setLive(EMPTY_TURN);
    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      for await (const chunk of readSse(res)) {
        if (chunk.error) {
          setError(chunk.error);
          continue;
        }
        setLive((prev) => reduceChunk(prev ?? EMPTY_TURN, chunk));
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "stream error");
    } finally {
      setLive(null);
      setPendingUser(null);
      setSending(false);
      await load();
      refreshChats();
    }
  }

  if (status === "not-found") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        Chat not found.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4">
        {status === "loading" && (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}
        {messages.map((message) => (
          <MessageView key={`${message.seq}`} message={message} />
        ))}
        {pendingUser !== null && (
          <MessageView
            message={{
              chatId,
              seq: -1,
              role: "user",
              content: pendingUser,
              createdAt: "",
            }}
          />
        )}
        {live && <LiveAssistant turn={live} />}
        <div ref={bottomRef} />
      </div>
      {error && (
        <p className="mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40">
          {error}
        </p>
      )}
      <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <Composer onSend={handleSend} disabled={sending} />
      </div>
    </div>
  );
}
