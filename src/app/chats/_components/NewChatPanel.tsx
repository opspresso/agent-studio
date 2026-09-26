"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { attachmentSrc, type Attachment } from "@/app/_lib/imageAttachments";
import { useT } from "@/app/_i18n/provider";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import { readJson } from "@/app/_lib/httpClient";
import { EMPTY_TURN, type AgentSummary } from "../_lib/types";
import { useRunEntry } from "../_lib/runHooks";
import { runStore } from "../_lib/runStore";
import { ChatThread } from "./ChatThread";
import { LiveAssistant, MessageView, RunningAgents } from "./parts";
import { Composer } from "./Composer";
import { onNewChat } from "./ChatSidebar";
import { Alert, Box, Button, Flex, Group, Loader, ScrollArea, Select, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconMessageCircle, IconArrowRight } from "@tabler/icons-react";
import { useLocalStorage } from "@mantine/hooks";
import classes from "./ChatThread.module.css";
import { AgentSuggestion } from "@/app/_components/AgentSuggestion";

const AGENT_KEY = "agent-studio-chat-agent";

export function NewChatPanel() {
  const t = useT();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The agent a new chat runs against, remembered per browser so the next one
  // opens on the last pick. Not synced across tabs: a pick made in another tab
  // must not swap the agent under a message being typed here.
  const [agentName, setAgentName] = useLocalStorage({
    key: AGENT_KEY,
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
    let cancelled = false;

    async function loadAgents() {
      try {
        const agents = await readJson<AgentSummary[]>(await fetch("/api/agents"));
        if (cancelled) return;
        setAgents(agents);
        if (agents.length > 0) {
          // The remembered Agent may have been deleted or renamed.
          setAgentName((current) =>
            agents.some((agent) => agent.name === current) ? current : agents[0]!.name,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setAgentsError(
            error instanceof Error ? error.message : t("agents.loadFailed"),
          );
        }
      } finally {
        if (!cancelled) setAgentsLoaded(true);
      }
    }
    void loadAgents();
    return () => {
      cancelled = true;
    };
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
        setDraft("");
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
    if (!agentsLoaded || !agents.some((agent) => agent.name === agentName) || starting) {
      return false;
    }
    setKey(runStore.startNewChat(agentName, { content, attachments, documents }));
    return true;
  }

  // Once the chat exists the thread takes over, reading the very same store
  // entry — so the streamed answer keeps painting with no loading gap.
  if (chatId) {
    return <ChatThread chatId={chatId} />;
  }

  if (!agentsLoaded) {
    return (
      <Flex h="100%" align="center" justify="center" role="status">
        <Group gap="sm">
          <Loader size="sm" />
          <Text c="dimmed" fz="sm">{t("common.loading")}</Text>
        </Group>
      </Flex>
    );
  }

  if (agentsLoaded && agents.length === 0) {
    return (
      <Flex h="100%" align="center" justify="center">
        <Stack gap="xs" maw={420} ta="center">
          {agentsError ? (
            <Alert color="red" variant="light">
              {agentsError}
            </Alert>
          ) : (
            <>
              <ThemeIcon size={56} radius="xl" variant="light" mx="auto">
                <IconMessageCircle size={28} />
              </ThemeIcon>
              <Title order={1} fz="h3">{t("chat.noAgentSummarys")}</Title>
              <Text fz="sm" c="dimmed">
                {t("chat.noAgentSummarysBody")}
              </Text>
              <Group justify="center" mt="sm">
                <Button component={Link} href="/agents" rightSection={<IconArrowRight size={16} />}>
                  {t("chrome.openAgents")}
                </Button>
                <Button component={Link} href="/guide" variant="default">{t("nav.guide")}</Button>
              </Group>
            </>
          )}
        </Stack>
      </Flex>
    );
  }

  const starting = entry?.status === "streaming";
  const selectedAgent = agents.find((agent) => agent.name === agentName);

  return (
    <Flex direction="column" h="100%">
      <ScrollArea style={{ flex: 1, minHeight: 0 }} pb="md">
        {entry?.pendingUser === undefined ? (
          <Box className={classes.welcome}>
            <div className={classes.welcomeContent}>
              <Text className={classes.welcomeLabel}>{t("chat.welcomeTitle")}</Text>
              <Title order={1} fz={{ base: 26, sm: 32 }}>
                {selectedAgent?.displayName || selectedAgent?.name || t("chat.welcomeTitle")}
              </Title>
              <Text fz="sm" c="dimmed" mt="xs" className={classes.agentDescription}>
                {selectedAgent?.description || t("chat.pickAgent")}
              </Text>
              <Text fz="xs" c="dimmed" mt="md">{t("chat.welcomeHint")}</Text>
            </div>
          </Box>
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
            {/* No clock here, and none to pass: this surface only ever draws the
                window before the head frame, since the render that first sees a
                chat id has already handed off to `ChatThread` above. The wait it
                covers is not lost — the head frame reports its own age, so the
                thread's stopwatch opens with the create, the claim and the
                upload already counted. */}
            {(starting || entry.live !== EMPTY_TURN) && (
              <LiveAssistant turn={entry.live} running={starting} />
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
            onDraftChange={setDraft}
            suggestion={<AgentSuggestion surface="chat" request={draft} candidates={agents} selected={agentName}
              onSelect={setAgentName} disabled={starting} />}
            disabled={starting || !selectedAgent}
            placeholder={t("chat.firstPlaceholder")}
            status={<RunningAgents paths={entry?.live.authorPaths ?? []} />}
            leading={(
              <Group gap="xs" align="center">
                <Text fz="xs" fw={500} c="dimmed">
                  {t("chat.agent")}
                </Text>
                <Select
                  aria-label={t("chat.agent")}
                  value={agentName}
                  onChange={(value) => setAgentName(value ?? "")}
                  disabled={starting}
                  allowDeselect={false}
                  searchable
                  data={agents.map((agent) => ({
                    value: agent.name,
                    label: agent.displayName || agent.name,
                  }))}
                />
              </Group>
            )}
            {...(starting && entry?.runId && key
              ? { onStop: () => runStore.cancelRun(key) }
              : {})}
          />
        </Box>
      </Box>
    </Flex>
  );
}
