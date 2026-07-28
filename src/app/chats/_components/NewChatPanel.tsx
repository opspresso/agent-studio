"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { readSse } from "../_lib/sseClient";
import { reduceChunk } from "../_lib/stream";
import { attachmentSrc, toRequestImages, type Attachment } from "@/app/_lib/imageAttachments";
import { EMPTY_TURN, type AgentProject, type LiveTurn } from "../_lib/types";
import { AttachButton, AttachmentBar, useAttachments } from "@/app/_components/ImageAttachments";
import { LiveAssistant, MessageView } from "./parts";
import { refreshChats } from "./ChatSidebar";
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
import { IconSend } from "@tabler/icons-react";

export function NewChatPanel() {
  const router = useRouter();
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [message, setMessage] = useState("");
  const [sentMessage, setSentMessage] = useState<{
    content: string;
    attachments: Attachment[];
  } | null>(null);
  // Staged attachments survive an error for a retry, the same way the typed
  // message does; a successful start navigates away and unmounts them.
  const { attachments, attachError, addFiles, removeAt } = useAttachments();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          setProjectName(agents[0]!.name);
        }
      }
      setProjectsLoaded(true);
    }
    void loadProjects();
  }, []);

  async function start() {
    const trimmed = message.trim();
    if (!projectName || (!trimmed && attachments.length === 0) || starting) {
      return;
    }
    setStarting(true);
    setError(null);
    setSentMessage({ content: trimmed, attachments });
    setLive(EMPTY_TURN);
    let newChatId: string | undefined;
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName,
          firstMessage: trimmed,
          images: toRequestImages(attachments),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `request failed (${res.status})`);
        setSentMessage(null);
        setLive(null);
        return;
      }
      for await (const chunk of readSse(res)) {
        if (chunk.chat) {
          newChatId = chunk.chat.chatId;
          continue;
        }
        if (chunk.error) {
          setError(chunk.error);
          continue;
        }
        setLive((prev) => reduceChunk(prev ?? EMPTY_TURN, chunk));
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "stream error");
    } finally {
      setStarting(false);
      refreshChats();
      if (newChatId) {
        router.push(`/chats/${newChatId}`);
      }
    }
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
          <AttachmentBar attachments={attachments} attachError={attachError} onRemove={removeAt} />
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <AttachButton onPick={(files) => void addFiles(files)} disabled={starting} />
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
