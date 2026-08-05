"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentSrc, type Attachment } from "@/app/_lib/imageAttachments";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import type { ChatMessageImage } from "@/domain/chat/types";
import { useRunEntry } from "../_lib/runHooks";
import { pinnedImages } from "../_lib/pins";
import { runStore } from "../_lib/runStore";
import type { Chat, ChatMessage } from "../_lib/types";
import { Composer, LiveAssistant, MessageView } from "./parts";
import { Alert, Badge, Box, Flex, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";

interface Fetched {
  messages: ChatMessage[];
  activeRun?: { runId: string };
}

export function ChatThread({ chatId }: { chatId: string }) {
  // The turn in flight lives in the store, above the router — a navigation away
  // and back finds it still going rather than losing it.
  const entry = useRunEntry(chatId);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Images already on screen this session, keyed by the message they persisted
  // to. Substituted for that message's stored copies at render, because the
  // stored URL points at an object the browser has never fetched — swapping the
  // src would blank the image for a network round-trip, which is the flicker
  // this exists to prevent. Doubles as the only copy when storage is
  // unconfigured and the stored message carries no images at all.
  const [sessionImagesBySeq, setSessionImagesBySeq] = useState<
    Record<number, ChatMessageImage[]>
  >({});
  const [status, setStatus] = useState<"loading" | "ready" | "not-found">("loading");
  const [error, setError] = useState<string | null>(null);
  /**
   * The last turn this view has finished showing. Retiring a turn by id rather
   * than by clearing the store is what keeps the swap to the persisted thread a
   * single commit: the streamed bubble stays on screen until its replacement is
   * already in state.
   */
  const [consumedId, setConsumedId] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const syncSeq = useRef(0);
  const consuming = useRef<number | null>(null);

  const shown = entry && entry.id !== consumedId ? entry : null;

  // Two syncs can be in flight — the mount's and a finished turn's — and the
  // slower one must not overwrite fresher messages with staler ones.
  const syncFromServer = useCallback(async (): Promise<Fetched | null> => {
    const ticket = ++syncSeq.current;
    const res = await fetch(`/api/chats/${chatId}`);
    if (ticket !== syncSeq.current) {
      return null;
    }
    if (res.status === 404) {
      setStatus("not-found");
      return null;
    }
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      chat?: Chat;
      messages?: ChatMessage[];
      activeRun?: { runId: string };
    };
    setChat(data.chat ?? null);
    setMessages(data.messages ?? []);
    setStatus("ready");
    return {
      messages: data.messages ?? [],
      ...(data.activeRun ? { activeRun: data.activeRun } : {}),
    };
  }, [chatId]);

  useEffect(() => {
    let dropped = false;
    void (async () => {
      const fresh = await syncFromServer();
      if (dropped || !fresh) {
        return;
      }
      // A run this view did not start — a reload mid-reply, or a second window.
      // Picking it up is what makes the answer keep arriving here.
      //
      // Anything not still streaming may be attached over, including a turn
      // whose connection was given up on: the server says a run is in flight, so
      // a finished entry from a stream that lost it is exactly what should be
      // replaced rather than what should block the replacement.
      if (fresh.activeRun && runStore.get(chatId)?.status !== "streaming") {
        runStore.attach(chatId, fresh.activeRun.runId);
      }
    })();
    return () => {
      dropped = true;
    };
  }, [chatId, syncFromServer]);

  // Retire a finished turn: fetch first, then commit everything at once.
  useEffect(() => {
    if (!shown || shown.status === "streaming" || consuming.current === shown.id) {
      return;
    }
    consuming.current = shown.id;
    const turn = shown;
    void (async () => {
      const fresh = await syncFromServer();
      if (!fresh) {
        consuming.current = null;
        return;
      }
      // Nothing may await between here and `setConsumedId`: these land in one
      // commit, which is what stops the streamed bubble disappearing before its
      // persisted replacement is on screen.
      setSessionImagesBySeq((prev) => ({
        ...prev,
        ...pinnedImages(fresh.messages, {
          images: turn.live.images,
          attachments: turn.pendingUser?.attachments ?? [],
        }),
      }));
      setError(turn.error ?? null);
      setConsumedId(turn.id);
    })();
  }, [shown, syncFromServer]);

  // After the commit, not during it: this frees the streamed image bytes.
  useEffect(() => {
    if (consumedId !== null) {
      runStore.release(chatId, consumedId);
    }
  }, [chatId, consumedId]);

  /**
   * Land at the bottom when a thread opens, follow along after.
   *
   * Smoothly scrolling into place on the first paint animates through the whole
   * history to reach where the reader already wanted to be — the longer the
   * chat, the longer they watch it happen. Following a reply as it arrives is
   * the opposite: the movement is what says new text landed. Keyed by chat id
   * so the jump happens again on a thread this view swapped to rather than
   * remounted for.
   */
  const anchoredTo = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    const behavior = anchoredTo.current === chatId ? "smooth" : "instant";
    anchoredTo.current = chatId;
    bottomRef.current?.scrollIntoView({ behavior });
  }, [chatId, status, messages, shown]);

  function handleSend(
    content: string,
    attachments: Attachment[],
    documents: DocumentAttachment[],
  ) {
    setError(null);
    runStore.startTurn(chatId, { content, attachments, documents });
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

  const streaming = shown?.status === "streaming";
  // The user's turn is written before the run starts, so a view that arrives
  // mid-run has it in `messages` already — drawing the pending copy too would
  // show it twice.
  const pendingUser =
    shown?.pendingUser && !messages.some((message) => message.seq === shown.userSeq)
      ? shown.pendingUser
      : null;
  const banner = shown?.error ?? error;

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
          {status === "loading" && !shown && (
            <Text fz="sm" c="dimmed">
              Loading…
            </Text>
          )}
          {messages.map((message) => {
            const pinned = sessionImagesBySeq[message.seq];
            const rendered =
              pinned && message.role !== "tool" ? { ...message, images: pinned } : message;
            return <MessageView key={`${message.seq}`} message={rendered} />;
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
          {shown && <LiveAssistant turn={shown.live} />}
          <div ref={bottomRef} />
        </Stack>
      </ScrollArea>
      {banner && (
        <Alert color="red" variant="light" mb="xs" py={6} px="sm" fz="xs">
          {banner}
        </Alert>
      )}
      <Box pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Composer
          onSend={handleSend}
          disabled={streaming}
          {...(streaming && shown.runId ? { onStop: () => runStore.cancelRun(chatId) } : {})}
        />
      </Box>
    </Flex>
  );
}
