"use client";

import { useEffect, useRef, useState } from "react";
import { attachmentSrc } from "@/app/_lib/imageAttachments";
import { EMPTY_TURN, type AgentProject } from "../_lib/types";
import { AttachButton, AttachmentBar, useAttachments } from "@/app/_components/ImageAttachments";
import { useRunEntry } from "../_lib/runHooks";
import { runStore } from "../_lib/runStore";
import { ChatThread } from "./ChatThread";
import { LiveAssistant, MessageView } from "./parts";
import { onNewChat } from "./ChatSidebar";
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
import { IconPlayerStopFilled, IconSend } from "@tabler/icons-react";

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
  // Staged attachments survive an error for a retry, the same way the typed
  // message does.
  const { attachments, documents, attachError, addFiles, removeDocumentAt, removeAt, clear } =
    useAttachments({ documents: true });
  /** The turn this panel started, read back from the store that owns it. */
  const [key, setKey] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  keyRef.current = key;
  const entry = useRunEntry(key);
  /**
   * Latched, not derived from the entry: the thread below frees the entry once
   * it has shown the turn, and a chat id read straight off it would go undefined
   * at that moment and unmount the thread from underneath itself.
   */
  const [handedOver, setHandedOver] = useState<string | null>(null);
  const chatId = entry?.chat?.chatId ?? handedOver;

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
  // this is the only thing that clears the thread it handed over to.
  useEffect(
    () =>
      onNewChat(() => {
        // Outside the state updater, which has to stay pure — React re-runs one
        // it discards, and double-invokes it in development.
        if (keyRef.current) {
          // Stops reading, not the run: a reply already in flight finishes and
          // is there in the sidebar, rather than being thrown away silently.
          runStore.abort(keyRef.current);
        }
        setKey(null);
        setHandedOver(null);
        setMessage("");
        clear();
      }),
    [clear],
  );

  // Shallow swap only — the panel keeps rendering the same turn. A hard refresh
  // from here serves /chats/[chatId] as usual.
  useEffect(() => {
    if (chatId) {
      setHandedOver(chatId);
      window.history.replaceState(null, "", `/chats/${chatId}`);
    }
  }, [chatId]);

  function start() {
    const trimmed = message.trim();
    // Guarded on the turn still running, not on there having been one: a first
    // message refused (409, over the cost limit, a dropped network) leaves the
    // key set, and guarding on that alone made Send do nothing for the rest of
    // the session — silently, since the button still looks enabled.
    if (
      !projectName ||
      (!trimmed && attachments.length === 0 && documents.length === 0) ||
      starting
    ) {
      return;
    }
    setKey(
      runStore.startNewChat(projectName, { content: trimmed, attachments, documents }),
    );
  }

  // Once the chat exists the thread takes over, reading the very same store
  // entry — so the streamed answer keeps painting with no loading gap.
  if (chatId) {
    return <ChatThread chatId={chatId} />;
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

  const starting = entry?.status === "streaming";

  return (
    <Flex direction="column" h="100%">
      <ScrollArea style={{ flex: 1, minHeight: 0 }} pb="md">
        {entry?.pendingUser === undefined ? (
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
                content: entry.pendingUser.content,
                documents: entry.pendingUser.documents.map((document) => ({
                  name: document.name,
                  text: "",
                })),
                images: entry.pendingUser.attachments.map((attachment) => ({
                  url: attachmentSrc(attachment),
                })),
                createdAt: "",
              }}
            />
            {/* Nothing yet and nothing coming — a first message refused leaves
                an entry holding an empty turn, and its bubble would promise a
                reply under the error saying there is none. */}
            {(starting || entry.live !== EMPTY_TURN) && <LiveAssistant turn={entry.live} />}
          </Stack>
        )}
      </ScrollArea>

      {entry?.error && (
        <Alert color="red" variant="light" mb="xs" py={6} px="sm" fz="xs">
          {entry.error}
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
                  start();
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
            {starting && entry?.runId ? (
              <ActionIcon
                variant="filled"
                color="red"
                size="input-sm"
                radius="xl"
                onClick={() => key && runStore.cancelRun(key)}
                aria-label="Stop"
              >
                <IconPlayerStopFilled size={16} />
              </ActionIcon>
            ) : (
              <ActionIcon
                variant="filled"
                size="input-sm"
                radius="xl"
                onClick={() => start()}
                loading={starting}
                disabled={(!message.trim() && attachments.length === 0) || !projectName}
                aria-label="Start chat"
              >
                <IconSend size={18} />
              </ActionIcon>
            )}
          </Group>
        </Stack>
      </Box>
    </Flex>
  );
}
