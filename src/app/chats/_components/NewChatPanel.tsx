"use client";

import { useEffect, useRef, useState } from "react";
import { attachmentSrc, type Attachment } from "@/app/_lib/imageAttachments";
import { useT } from "@/app/_i18n/provider";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import { EMPTY_TURN, type AgentProject } from "../_lib/types";
import { useRunEntry } from "../_lib/runHooks";
import { runStore } from "../_lib/runStore";
import { ChatThread } from "./ChatThread";
import { LiveAssistant, MessageView, RunningAgents } from "./parts";
import { Composer } from "./Composer";
import { onNewChat } from "./ChatSidebar";
import { Alert, Box, Flex, Group, ScrollArea, Select, Stack, Text } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import classes from "./ChatThread.module.css";

const PROJECT_KEY = "agent-studio-chat-project";

export function NewChatPanel() {
  const t = useT();
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
  /** The turn this panel started, read back from the store that owns it. */
  const [key, setKey] = useState<string | null>(null);
  /** Bumped to remount the composer, which is what discards a draft. */
  const [composerKey, setComposerKey] = useState(0);
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
        // The composer owns the draft and its attachments; remounting it under a
        // new key is what clears them.
        setComposerKey((n) => n + 1);
      }),
    [],
  );

  // Shallow swap only — the panel keeps rendering the same turn. A hard refresh
  // from here serves /chats/[chatId] as usual.
  useEffect(() => {
    if (chatId) {
      setHandedOver(chatId);
      window.history.replaceState(null, "", `/chats/${chatId}`);
    }
  }, [chatId]);

  function start(
    content: string,
    attachments: Attachment[],
    documents: DocumentAttachment[],
  ): boolean {
    // Guarded on the turn still running, not on there having been one: a first
    // message refused (a 409, the cost limit, a dropped network) leaves the
    // key set, and guarding on that alone made Send do nothing for the rest of
    // the session — silently, since the button still looks enabled. Refused
    // sends report themselves so the composer keeps the draft.
    if (!projectName || starting) {
      return false;
    }
    setKey(runStore.startNewChat(projectName, { content, attachments, documents }));
    return true;
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
          <Text fw={500}>{t("chat.noAgentProjects")}</Text>
          <Text fz="sm" c="dimmed">
            {t("chat.noAgentProjectsBody")}
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
              {t("chat.pickProject")}
            </Text>
          </Flex>
        ) : (
          <Stack gap="sm" className={classes.column}>
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
            {(starting || entry.live !== EMPTY_TURN) && (
              <LiveAssistant
                turn={entry.live}
                running={starting}
                {...(entry.startedAtMs !== undefined
                  ? { startedAtMs: entry.startedAtMs }
                  : {})}
              />
            )}
          </Stack>
        )}
      </ScrollArea>

      <Box pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Box className={classes.column}>
          {entry?.error && (
            <Alert color="red" variant="light" mb="xs" py={6} px="sm" fz="xs">
              {entry.error}
            </Alert>
          )}
          <Composer
            key={composerKey}
            onSend={start}
            disabled={starting}
            placeholder={t("chat.firstPlaceholder")}
            status={<RunningAgents paths={entry?.live.authorPaths ?? []} />}
            leading={
              <Group gap="xs" align="center">
                <Text fz="xs" fw={500} c="dimmed">
                  {t("chat.project")}
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
            }
            {...(starting && entry?.runId && key
              ? { onStop: () => runStore.cancelRun(key) }
              : {})}
          />
        </Box>
      </Box>
    </Flex>
  );
}
