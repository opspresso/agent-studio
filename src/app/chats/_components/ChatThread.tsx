"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { readSse } from "../_lib/sseClient";
import { reduceChunk } from "../_lib/stream";
import { attachmentSrc, toRequestImages, type Attachment } from "@/app/_lib/imageAttachments";
import { EMPTY_TURN, type Chat, type ChatMessage, type LiveImage, type LiveTurn } from "../_lib/types";
import { Composer, GeneratedImage, LiveAssistant, MessageView, liveImageSrc } from "./parts";
import { refreshChats } from "./ChatSidebar";
import { Alert, Badge, Box, Flex, Group, ScrollArea, Stack, Text } from "@mantine/core";

export function ChatThread({ chatId }: { chatId: string }) {
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingUser, setPendingUser] = useState<{
    content: string;
    attachments: Attachment[];
  } | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  // Fallback when image persistence is unconfigured (no S3 bucket): keep the
  // images streamed this session and pin them to the message they arrived with.
  const [imagesBySeq, setImagesBySeq] = useState<Record<number, LiveImage[]>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "not-found">("loading");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<ChatMessage[] | null> => {
    const res = await fetch(`/api/chats/${chatId}`);
    if (res.status === 404) {
      setStatus("not-found");
      return null;
    }
    if (res.ok) {
      const data = (await res.json()) as { chat?: Chat; messages?: ChatMessage[] };
      setChat(data.chat ?? null);
      setMessages(data.messages ?? []);
      setStatus("ready");
      return data.messages ?? [];
    }
    return null;
  }, [chatId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, pendingUser]);

  async function handleSend(content: string, attachments: Attachment[]) {
    setSending(true);
    setError(null);
    setPendingUser({ content, attachments });
    setLive(EMPTY_TURN);
    const streamedImages: LiveImage[] = [];
    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, images: toRequestImages(attachments) }),
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
        if (chunk.image) {
          streamedImages.push(chunk.image);
        }
        setLive((prev) => reduceChunk(prev ?? EMPTY_TURN, chunk));
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "stream error");
    } finally {
      setLive(null);
      setPendingUser(null);
      setSending(false);
      const fresh = await load();
      const lastMessage = fresh?.[fresh.length - 1];
      const persisted =
        lastMessage?.role === "assistant" && (lastMessage.images?.length ?? 0) > 0;
      if (streamedImages.length > 0 && lastMessage !== undefined && !persisted) {
        setImagesBySeq((prev) => ({ ...prev, [lastMessage.seq]: streamedImages }));
      }
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
          <Badge color="brand" radius="xl">
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
          {messages.map((message) => (
            <Fragment key={`${message.seq}`}>
              <MessageView message={message} />
              {(imagesBySeq[message.seq] ?? []).map((image, index) => (
                <Group key={`image-${message.seq}-${index}`} justify="flex-start">
                  <GeneratedImage
                    src={liveImageSrc(image)}
                    alt={image.prompt ?? "Generated image"}
                  />
                </Group>
              ))}
            </Fragment>
          ))}
          {pendingUser !== null && (
            <MessageView
              message={{
                chatId,
                seq: -1,
                role: "user",
                content: pendingUser.content,
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
