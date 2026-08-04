"use client";

import { useEffect, useRef, useState } from "react";
import { readSse } from "../_lib/sseClient";
import { reduceChunk } from "../_lib/stream";
import { attachmentSrc, toRequestImages, type Attachment } from "@/app/_lib/imageAttachments";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import { EMPTY_TURN, type AgentProject, type Chat, type LiveTurn } from "../_lib/types";
import { isTopLevelChunk } from "@/domain/llm/types";
import { AttachButton, AttachmentBar, useAttachments } from "@/app/_components/ImageAttachments";
import { ChatThread } from "./ChatThread";
import { LiveAssistant, MessageView } from "./parts";
import { onNewChat, refreshChats } from "./ChatSidebar";
import {
  ActionIcon,
  Alert,
  Box,
  Flex,
  Group,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconSend } from "@tabler/icons-react";

const PROJECT_KEY = "agent-studio-chat-project";

export function NewChatPanel() {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  // The project a new chat runs against, remembered per browser so the next one
  // opens on the last pick. Not synced across tabs: a pick made in another tab
  // must not swap the project under a message being typed here.
  const [projectName, setProjectName] = useLocalStorage({
    key: PROJECT_KEY,
    defaultValue: "",
    sync: false,
  });
  const [message, setMessage] = useState("");
  const [sentMessage, setSentMessage] = useState<{
    content: string;
    attachments: Attachment[];
    documents: DocumentAttachment[];
  } | null>(null);
  // Staged attachments survive an error for a retry, the same way the typed
  // message does; a successful start navigates away and unmounts them.
  const { attachments, documents, attachError, addFiles, removeAt, removeDocumentAt, clear } =
    useAttachments({ documents: true });
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The created chat, captured from the stream's envelope chunk. Once the
  // first turn finishes, the panel renders ChatThread in place instead of
  // navigating — a route change here would unmount the streamed answer and
  // flash a loading screen, which reads as a page reload.
  const [handoffChat, setHandoffChat] = useState<Chat | null>(null);
  const [done, setDone] = useState(false);
  // Which turn the panel is showing. A reset retires the current one, so a
  // stream still in flight is aborted and whatever chunk it already read is
  // dropped instead of painting over the emptied panel.
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    async function loadProjects() {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data: unknown = await res.json();
        const list = Array.isArray(data)
          ? (data as AgentProject[])
          : ((data as { projects?: AgentProject[] }).projects ?? []);
        const agents = list.filter((project) => project.projectType === "agent");
        setProjects(agents);
        if (agents.length > 0) {
          // The remembered project may have been deleted, renamed, or turned
          // into another project type since it was stored — the list decides.
          setProjectName((current) =>
            agents.some((project) => project.name === current) ? current : agents[0]!.name,
          );
        }
      }
      setProjectsLoaded(true);
    }
    void loadProjects();
  }, []);

  // The first turn swaps the URL to /chats/<id> without a route change, so this
  // panel stays the mounted /chats segment: "New chat" navigates nowhere and
  // this is the only thing that clears the finished thread.
  useEffect(
    () =>
      onNewChat(() => {
        runRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        setSentMessage(null);
        setLive(null);
        setHandoffChat(null);
        setDone(false);
        setError(null);
        setStarting(false);
        setMessage("");
        clear();
      }),
    [clear],
  );

  async function start() {
    const trimmed = message.trim();
    if (
      !projectName ||
      (!trimmed && attachments.length === 0 && documents.length === 0) ||
      starting
    ) {
      return;
    }
    const run = ++runRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setStarting(true);
    setError(null);
    setSentMessage({ content: trimmed, attachments, documents });
    setLive(EMPTY_TURN);
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName,
          firstMessage: trimmed,
          images: toRequestImages(attachments),
          documents,
        }),
        signal: controller.signal,
      });
      if (runRef.current !== run) {
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `request failed (${res.status})`);
        setSentMessage(null);
        setLive(null);
        return;
      }
      for await (const chunk of readSse(res)) {
        if (runRef.current !== run) {
          return;
        }
        if (chunk.chat) {
          setHandoffChat(chunk.chat);
          // Shallow URL swap only — the panel keeps rendering the stream. A
          // hard refresh from here serves /chats/[chatId] as usual.
          window.history.replaceState(null, "", `/chats/${chunk.chat.chatId}`);
          continue;
        }
        if (chunk.error) {
          // Same rule as ChatThread: only a top-level error is the run's — an
          // authored one is a subagent failure the parent may answer past.
          if (isTopLevelChunk(chunk)) {
            setError(chunk.error);
          }
          continue;
        }
        setLive((prev) => reduceChunk(prev ?? EMPTY_TURN, chunk));
      }
    } catch (streamError) {
      if (runRef.current === run) {
        setError(streamError instanceof Error ? streamError.message : "stream error");
      }
    } finally {
      // The chat is created before the first chunk, so the sidebar is refreshed
      // even for a turn the panel has moved on from.
      refreshChats();
      if (runRef.current === run) {
        abortRef.current = null;
        setStarting(false);
        setDone(true);
      }
    }
  }

  if (done && handoffChat && sentMessage) {
    return (
      <ChatThread
        chatId={handoffChat.chatId}
        initial={{ chat: handoffChat, pendingUser: sentMessage, live: live ?? EMPTY_TURN }}
      />
    );
  }

  if (projectsLoaded && projects.length === 0) {
    return (
      <Flex h="100%" align="center" justify="center">
        <Stack gap="xs" maw={420} ta="center">
          <Text fw={500}>No agent projects yet</Text>
          <Text fz="sm" c="dimmed">
            Chats run against an <b>agent</b> project. Create one from Projects to start chatting.
          </Text>
        </Stack>
      </Flex>
    );
  }

  return (
    <Flex direction="column" h="100%">
      <ScrollArea style={{ flex: 1, minHeight: 0 }} pb="md">
        {sentMessage === null ? (
          <Flex h="100%" align="center" justify="center" py="xl">
            <Text fz="sm" c="dimmed">
              Pick an agent project and send your first message.
            </Text>
          </Flex>
        ) : (
          <Stack gap="sm">
            <MessageView
              message={{
                chatId: "",
                seq: 0,
                role: "user",
                content: sentMessage.content,
                documents: sentMessage.documents.map((document) => ({
                  name: document.name,
                  text: "",
                })),
                images: sentMessage.attachments.map((attachment) => ({
                  url: attachmentSrc(attachment),
                })),
                createdAt: "",
              }}
            />
            {live && <LiveAssistant turn={live} />}
          </Stack>
        )}
      </ScrollArea>

      {error && (
        <Alert color="red" variant="light" mb="xs" py={6} px="sm" fz="xs">
          {error}
        </Alert>
      )}

      <Box pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Stack gap="xs">
          <Group gap="xs" align="center">
            <Text fz="xs" fw={500} c="dimmed">
              Project
            </Text>
            <Select
              value={projectName}
              onChange={(value) => setProjectName(value ?? "")}
              disabled={starting}
              allowDeselect={false}
              data={projects.map((project) => ({
                value: project.name,
                label: project.displayName || project.name,
              }))}
            />
          </Group>
          <AttachmentBar
            attachments={attachments}
            documents={documents}
            attachError={attachError}
            onRemove={removeAt}
            onRemoveDocument={removeDocumentAt}
          />
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <AttachButton onPick={(files) => void addFiles(files)} disabled={starting} documents />
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void start();
                }
              }}
              autosize
              minRows={1}
              maxRows={8}
              radius="xl"
              placeholder="Send your first message…"
              disabled={starting}
              style={{ flex: 1 }}
            />
            <ActionIcon
              variant="filled"
              size="input-sm"
              radius="xl"
              onClick={() => void start()}
              loading={starting}
              disabled={(!message.trim() && attachments.length === 0) || !projectName}
              aria-label="Start chat"
            >
              <IconSend size={18} />
            </ActionIcon>
          </Group>
        </Stack>
      </Box>
    </Flex>
  );
}
