"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readSse } from "../_lib/sseClient";
import { reduceChunk } from "../_lib/stream";
import { attachmentSrc, toRequestImages, type Attachment } from "@/app/_lib/imageAttachments";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import { EMPTY_TURN, type Chat, type ChatMessage, type LiveImage, type LiveTurn } from "../_lib/types";
import type { ChatMessageImage } from "@/domain/chat/types";
import { isTopLevelChunk } from "@/domain/llm/types";
import { Composer, LiveAssistant, MessageView, liveImageSrc } from "./parts";
import { refreshChats } from "./ChatSidebar";
import { Alert, Badge, Box, Flex, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";

/** Streamed first turn handed over from NewChatPanel so the thread paints
 * without a loading gap; the persisted copy replaces it in one commit. */
export interface ThreadHandoff {
  chat: Chat;
  pendingUser: {
    content: string;
    attachments: Attachment[];
    documents: DocumentAttachment[];
  };
  live: LiveTurn;
}

export function ChatThread({ chatId, initial }: { chatId: string; initial?: ThreadHandoff }) {
  const [chat, setChat] = useState<Chat | null>(initial?.chat ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingUser, setPendingUser] = useState<{
    content: string;
    attachments: Attachment[];
    documents: DocumentAttachment[];
  } | null>(initial?.pendingUser ?? null);
  const [live, setLive] = useState<LiveTurn | null>(initial?.live ?? null);
  // Images already on screen this session, keyed by the message they persisted
  // to. Substituted for that message's stored copies at render, because the
  // stored URL points at an object the browser has never fetched — swapping the
  // src would blank the image for a network round-trip, which is the flicker
  // this exists to prevent. Doubles as the only copy when storage is
  // unconfigured and the stored message carries no images at all.
  const [sessionImagesBySeq, setSessionImagesBySeq] = useState<
    Record<number, ChatMessageImage[]>
  >({});
  const [status, setStatus] = useState<"loading" | "ready" | "not-found">(
    initial ? "ready" : "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Replace whatever is on screen with the persisted thread in a single
  // commit: fetch first, then batch all state updates, so the streamed bubble
  // and the pending user message never disappear before their persisted
  // replacements are ready. On a failed fetch the screen is left untouched.
  const syncFromServer = useCallback(async (): Promise<ChatMessage[] | null> => {
    const res = await fetch(`/api/chats/${chatId}`);
    if (res.status === 404) {
      setStatus("not-found");
      return null;
    }
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { chat?: Chat; messages?: ChatMessage[] };
    setChat(data.chat ?? null);
    setMessages(data.messages ?? []);
    setLive(null);
    setPendingUser(null);
    setStatus("ready");
    return data.messages ?? [];
  }, [chatId]);

  // Sync, then pin the turn's images — the user's attachments to the user
  // message, the generated ones to the assistant message — so the persisted
  // thread keeps rendering the bytes already on screen.
  const syncAndPin = useCallback(
    async (streamedImages: LiveImage[], attachments: Attachment[]) => {
      const fresh = await syncFromServer();
      if (!fresh) {
        return fresh;
      }
      const pinned: Record<number, ChatMessageImage[]> = {};
      if (attachments.length > 0) {
        const lastUser = [...fresh].reverse().find((message) => message.role === "user");
        if (lastUser) {
          pinned[lastUser.seq] = attachments.map((attachment) => ({
            url: attachmentSrc(attachment),
          }));
        }
      }
      if (streamedImages.length > 0) {
        const lastAssistant = [...fresh]
          .reverse()
          .find((message) => message.role === "assistant");
        if (lastAssistant) {
          pinned[lastAssistant.seq] = streamedImages.map((image) =>
            image.prompt === undefined
              ? { url: liveImageSrc(image) }
              : { url: liveImageSrc(image), prompt: image.prompt },
          );
        }
      }
      if (Object.keys(pinned).length > 0) {
        setSessionImagesBySeq((prev) => ({ ...prev, ...pinned }));
      }
      return fresh;
    },
    [syncFromServer],
  );

  // Consumed once: a later re-sync (e.g. a chatId change) must not pin the
  // handed-over first turn's images onto another thread's messages.
  const handoff = useRef(
    initial ? { images: initial.live.images, attachments: initial.pendingUser.attachments } : null,
  );

  useEffect(() => {
    const carried = handoff.current;
    handoff.current = null;
    void syncAndPin(carried?.images ?? [], carried?.attachments ?? []);
  }, [syncAndPin]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, pendingUser]);

  async function handleSend(
    content: string,
    attachments: Attachment[],
    documents: DocumentAttachment[],
  ) {
    setSending(true);
    setError(null);
    setPendingUser({ content, attachments, documents });
    setLive(EMPTY_TURN);
    const streamedImages: LiveImage[] = [];
    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, images: toRequestImages(attachments), documents }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      for await (const chunk of readSse(res)) {
        if (chunk.error) {
          // An authored error is a subagent failure the parent usually answers
          // past; a page-level banner would report a finished conversation as
          // failed. Only a top-level error is the run's.
          if (isTopLevelChunk(chunk)) {
            setError(chunk.error);
          }
          continue;
        }
        if (chunk.image) {
          streamedImages.push(chunk.image);
        }
        setLive((prev) => reduceChunk(prev ?? EMPTY_TURN, chunk));
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "stream error");
    } finally {
      setSending(false);
      await syncAndPin(streamedImages, attachments);
      refreshChats();
    }
  }

  if (status === "not-found") {
    return (
      <Flex h="100%" align="center" justify="center">
        <Text fz="sm" c="dimmed">
          Chat not found.
        </Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" h="100%">
      {chat?.projectName && (
        <Group
          gap="xs"
          pb="xs"
          mb="sm"
          style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
        >
          <Badge color={BADGE.owned} radius="xl">
            {chat.projectName}
          </Badge>
        </Group>
      )}
      <ScrollArea style={{ flex: 1, minHeight: 0 }} pb="md">
        <Stack gap="sm">
          {status === "loading" && (
            <Text fz="sm" c="dimmed">
              Loading…
            </Text>
          )}
          {messages.map((message) => {
            const pinned = sessionImagesBySeq[message.seq];
            const shown =
              pinned && message.role !== "tool" ? { ...message, images: pinned } : message;
            return <MessageView key={`${message.seq}`} message={shown} />;
          })}
          {pendingUser !== null && (
            <MessageView
              message={{
                chatId,
                seq: -1,
                role: "user",
                content: pendingUser.content,
                documents: pendingUser.documents.map((document) => ({
                  name: document.name,
                  text: "",
                })),
                images: pendingUser.attachments.map((attachment) => ({
                  url: attachmentSrc(attachment),
                })),
                createdAt: "",
              }}
            />
          )}
          {live && <LiveAssistant turn={live} />}
          <div ref={bottomRef} />
        </Stack>
      </ScrollArea>
      {error && (
        <Alert color="red" variant="light" mb="xs" py={6} px="sm" fz="xs">
          {error}
        </Alert>
      )}
      <Box pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Composer onSend={handleSend} disabled={sending} />
      </Box>
    </Flex>
  );
}
