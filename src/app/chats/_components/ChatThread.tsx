"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestScroll } from "@/app/_lib/useLatestScroll";
import { attachmentSrc, type Attachment } from "@/app/_lib/imageAttachments";
import { useT } from "@/app/_i18n/provider";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import type { ChatMessageImage } from "@/domain/chat/types";
import { useRunEntry } from "../_lib/runHooks";
import { pinnedImages } from "../_lib/pins";
import { storedToolArgs } from "../_lib/toolPairs";
import { answerDurations } from "../_lib/turnDuration";
import { runStore } from "../_lib/runStore";
import { EMPTY_TURN, type Chat, type ChatMessage } from "../_lib/types";
import { LiveAssistant, MessageView, RunningAgents } from "./parts";
import { Composer } from "./Composer";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Flex,
  Group,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import { BADGE } from "@/app/_components/badgeColors";
import classes from "./ChatThread.module.css";
import { highestSeq, mergeMessages } from "../_lib/mergeMessages";
import { SIGNATURE_REFRESH_MS } from "../_lib/refresh";
import type { ChatWithMessages } from "@/application/chat/getChat";
import { PendingApproval } from "./PendingApproval";
import { startSequentialPoll } from "@/shared/sequentialPoll";

interface Fetched {
  messages: ChatMessage[];
  activeRun?: { runId: string };
}

/** How often a retire sync that could not answer is tried again, and how far apart. */
const RETIRE_RETRIES = 3;
const RETIRE_RETRY_MS = 2_000;

/**
 * How many times this view will pick up the same run. The retire path below can
 * start an attach, so without a ceiling a run that cannot be read at all would
 * have every failure ask for it again.
 */
const MAX_ATTACHES = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ChatThread({ chatId }: { chatId: string }) {
  const t = useT();
  // The turn in flight lives in the store, above the router — a navigation away
  // and back finds it still going rather than losing it.
  const entry = useRunEntry(chatId);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvalState, setApprovalState] = useState<{ chatId: string; pending: ChatWithMessages["pendingApproval"] } | null>(null);
  const pendingApproval = approvalState?.chatId === chatId ? approvalState.pending : null;
  // Images already on screen this session, keyed by the message they persisted
  // to. Substituted for that message's stored copies at render, because the
  // stored URL points at an object the browser has never fetched — swapping the
  // src would blank the image for a network round-trip, which is the flicker
  // this exists to prevent. Doubles as the only copy when storage is
  // unconfigured and the stored message carries no images at all.
  const [sessionImagesBySeq, setSessionImagesBySeq] = useState<
    Record<number, ChatMessageImage[]>
  >({});
  /**
   * The newest sequence this view holds — what a tail read asks from.
   *
   * A ref and not state: it is read inside `syncFromServer` and never
   * rendered, and as a dependency it would re-fire the mount fetch on every
   * message the thread gains.
   */
  const held = useRef<number | undefined>(undefined);
  /**
   * The chat on screen right now, for the async work that outlives a
   * navigation to read. The retire loop below holds the `chatId` it started
   * for, and everything it touches afterwards — `held`, `chat`, `messages` —
   * belongs to whichever chat is current, not to that one.
   */
  const showing = useRef(chatId);
  showing.current = chatId;
  /**
   * When this view last read the whole thread — which is the last time every
   * stored image and file in it was signed. `refresh.ts` says why that has a
   * ceiling.
   */
  const lastFullRead = useRef(0);
  const [status, setStatus] = useState<"loading" | "load-error" | "ready" | "not-found">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * The last turn this view has finished showing. Retiring a turn by id rather
   * than by clearing the store is what keeps the swap to the persisted thread a
   * single commit: the streamed bubble stays on screen until its replacement is
   * already in state.
   */
  const [consumedId, setConsumedId] = useState<number | null>(null);
  /**
   * Who owns the viewport while a reply streams.
   *
   * Not an effect that scrolls on every render, which is what this replaced: the
   * store hands out a new entry per stream frame, so a `scrollIntoView` keyed on
   * it ran dozens of times a second, dragged the reader back down every time
   * they tried to leave, and — being `smooth` — restarted its own animation
   * before the last one finished, which is the juddering that was reported.
   *
   * `instant` on both counts is deliberate. On resize it is what pins the last
   * line to the bottom edge instead of animating after it; on the initial render
   * it lands at the bottom rather than scrolling the whole history past the
   * reader to get there.
   */
  const { scrollRef, contentRef, isNearBottom, scrollToBottom } = useLatestScroll(status === "ready", chatId);
  const syncSeq = useRef(0);
  const consuming = useRef<number | null>(null);
  /** The run this view last picked up, and how many times — see `MAX_ATTACHES`. */
  const attached = useRef<{ runId: string; count: number } | null>(null);

  const shown = entry && entry.id !== consumedId ? entry : null;

  /**
   * The conversation as it is drawn, rebuilt only when it actually changes.
   *
   * Substituting this session's images inline — `{...message, images: pinned}`
   * in the render — minted a new object for those messages on every pass, which
   * is every stream frame, and a memoised `MessageView` cannot hold against a
   * new prop. Doing it here means the array and its entries keep their identity
   * for the whole of a reply.
   */
  const drawn = useMemo(
    () =>
      messages.map((message) => {
        const pinned = sessionImagesBySeq[message.seq];
        return pinned && message.role !== "tool" ? { ...message, images: pinned } : message;
      }),
    [messages, sessionImagesBySeq],
  );

  /**
   * What each stored tool row was called with. Its own message does not carry
   * that — the arguments are on the assistant message that declared the call —
   * so without this a reloaded conversation says a skill ran and never which.
   */
  const toolArgs = useMemo(() => storedToolArgs(messages), [messages]);
  /** How long each stored answer took, paired off the timestamps around it. */
  const durations = useMemo(() => answerDurations(messages), [messages]);

  // Two syncs can be in flight — the mount's and a finished turn's — and the
  // slower one must not overwrite fresher messages with staler ones.
  const syncFromServer = useCallback(
    async ({ tail = false } = {}): Promise<Fetched | null> => {
      const ticket = ++syncSeq.current;
      const failed = () => {
        if (ticket === syncSeq.current) {
          // A failed first read needs an explicit recovery action. Once history
          // is available, tail failures keep it visible and use the retire or
          // workspace poll's existing retries instead.
          setStatus((current) => current === "loading" ? "load-error" : current);
        }
        return null;
      };
      // The tail read asks only for what was written after the newest row this
      // view holds. Read from a ref rather than from `messages` on purpose: as
      // a dependency it would give this callback a new identity on every
      // arriving row, and the mount effect that depends on it would re-fetch
      // the thread each time it grew.
      // A tail read only when one is still safe: the signatures on the rows
      // already on screen were minted by the last full read, and past
      // `SIGNATURE_REFRESH_MS` the cheap read would leave them to expire.
      const stale = Date.now() - lastFullRead.current >= SIGNATURE_REFRESH_MS;
      const since = tail && !stale ? held.current : undefined;
      let res: Response;
      try {
        res = await fetch(
          since === undefined ? `/api/chats/${chatId}` : `/api/chats/${chatId}?sinceSeq=${since}`,
        );
      } catch {
        return failed();
      }
      if (ticket !== syncSeq.current) {
        return null;
      }
      if (res.status === 404) {
        setStatus("not-found");
        return null;
      }
      if (!res.ok) {
        return failed();
      }
      let data: ChatWithMessages;
      try {
        data = (await res.json()) as typeof data;
      } catch {
        return failed();
      }
      // Checked again, after the body: the first check only proves no fresher
      // request had *started* when the headers arrived. A mount's full read
      // parked on `res.json()` while a retire's tail read overtook it would
      // otherwise land here and replace the merged thread with its own older
      // copy — and rewind `held` with it, so the next tail asks for rows
      // already on screen.
      if (ticket !== syncSeq.current) {
        return null;
      }
      if (!data?.chat || !Array.isArray(data.messages)) {
        return failed();
      }
      const fetched = data.messages;
      if (since === undefined) {
        lastFullRead.current = Date.now();
      }
      setChat(data.chat);
      setApprovalState({ chatId, pending: data.pendingApproval ?? null });
      setMessages((prev) => (since === undefined ? fetched : mergeMessages(prev, fetched)));
      // Outside the updater, which React may run twice and which must stay
      // pure. A full read replaces what is held; a tail read can only extend
      // it, and `Math.max` is what keeps an out-of-order arrival from moving
      // the marker backwards onto rows already merged in.
      const newest = highestSeq(fetched);
      if (newest !== undefined) {
        held.current = since === undefined || held.current === undefined
          ? newest
          : Math.max(held.current, newest);
      } else if (since === undefined) {
        held.current = undefined;
        lastFullRead.current = 0;
      }
      setStatus("ready");
      // The *fetched* rows, not the merged thread: what pins this turn's images
      // is a backwards scan for the newest user and assistant rows, and on a
      // tail read those are exactly what came back.
      return {
        messages: fetched,
        ...(data.activeRun ? { activeRun: data.activeRun } : {}),
      };
    },
    [chatId],
  );

  /**
   * Pick up a run this view did not start — a reload mid-reply, a second window,
   * or a stream this view gave up on while the run carried on writing.
   *
   * Anything not still streaming may be attached over, including a turn whose
   * connection was given up on: the server says a run is in flight, so a
   * finished entry from a stream that lost it is exactly what should be replaced
   * rather than what should block the replacement. Reported back, because the
   * error such a turn left behind is no longer true once its run is being read
   * again.
   *
   * One run can slip past the streaming check: a new chat's own, still keyed
   * under its `new:` placeholder until the head frame names the chat. The
   * store cannot match it to this `chatId` before that, so a click landing in
   * the round-trip the head frame takes opens a short-lived duplicate stream —
   * which `adopt()` discards the moment the head arrives.
   */
  const attachIfRunning = useCallback(
    (fresh: Fetched): boolean => {
      const runId = fresh.activeRun?.runId;
      if (!runId || runStore.get(chatId)?.status === "streaming") {
        return false;
      }
      const taken = attached.current?.runId === runId ? attached.current.count : 0;
      if (taken >= MAX_ATTACHES) {
        return false;
      }
      attached.current = { runId, count: taken + 1 };
      runStore.attach(chatId, runId);
      return true;
    },
    [chatId],
  );

  useEffect(() => {
    let dropped = false;
    // A different chat holds different sequences, so a retire firing inside the
    // round-trip must not ask the new chat for the old one's tail. The page
    // keys this view by `chatId` now, so a navigation remounts and this starts
    // undefined anyway — it stays because the effect also re-runs without one.
    held.current = undefined;
    void (async () => {
      const fresh = await syncFromServer();
      if (dropped || !fresh) {
        return;
      }
      attachIfRunning(fresh);
    })();
    return () => {
      dropped = true;
    };
  }, [syncFromServer, attachIfRunning, loadAttempt]);

  const hasWorkspace = Object.keys(chat?.linkedWorkspaces ?? {}).length > 0;
  useEffect(() => {
    if (!hasWorkspace) return;
    return startSequentialPoll({
      intervalMs: 3_000,
      async poll(signal) {
        if (document.visibilityState !== "visible" || runStore.get(chatId)?.status === "streaming") return;
        const fresh = await syncFromServer({ tail: true });
        if (!signal.aborted && fresh) attachIfRunning(fresh);
      },
      onError: () => { /* The next bounded tail read can recover a transport failure. */ },
    });
  }, [hasWorkspace, chatId, syncFromServer, attachIfRunning]);

  // Retire a finished turn: fetch first, then commit everything at once.
  useEffect(() => {
    if (!shown || shown.status === "streaming" || consuming.current === shown.id) {
      return;
    }
    consuming.current = shown.id;
    const turn = shown;
    const forChat = chatId;
    void (async () => {
      // A sync that cannot answer — a transient 5xx, or one overtaken by a
      // fresher request — is tried again rather than dropped. Nothing re-fires
      // this effect afterwards, so giving up on the first failure leaves the
      // turn un-retired: `runStore.release` is never called, and a minute later
      // the store's own eviction takes the finished answer off the screen with
      // no error and nothing to click.
      for (let attempt = 0; ; attempt += 1) {
        // The retire that outlived its chat stops here rather than at its
        // sync's ticket: the retry *takes* the newest ticket, so nothing
        // downstream can tell it is stale. It would ask this chat's endpoint
        // for a tail measured against another chat's sequence, then commit
        // the answer over the thread the reader is actually looking at.
        if (showing.current !== forChat) {
          return;
        }
        // A tail read: this view watched the run arrive and holds every turn
        // before it, so a full transcript read would only re-sign stored images.
        const fresh = await syncFromServer({ tail: true });
        // Still the retire in charge of this turn? Deliberately this rather than
        // a flag an effect cleanup sets: the re-run does not redo the work — the
        // guard above returns early — so a cleanup flag would abandon the retire
        // and start nothing in its place, which in development's strict mode is
        // every single mount.
        if (consuming.current !== turn.id) {
          return;
        }
        if (fresh) {
          // Nothing may await between here and `setConsumedId`: these land in
          // one commit, which is what stops the streamed bubble disappearing
          // before its persisted replacement is on screen.
          setSessionImagesBySeq((prev) => ({
            ...prev,
            ...pinnedImages(fresh.messages, {
              images: turn.live.images,
              attachments: turn.pendingUser?.attachments ?? [],
            }),
          }));
          const resumed = attachIfRunning(fresh);
          setError(resumed ? null : (turn.error ?? null));
          setConsumedId(turn.id);
          return;
        }
        if (attempt >= RETIRE_RETRIES) {
          consuming.current = null;
          setError(t("chat.reloadFailed"));
          return;
        }
        await delay(RETIRE_RETRY_MS);
      }
    })();
  }, [shown, syncFromServer, attachIfRunning]);

  // After the commit, not during it: this frees the streamed image bytes.
  useEffect(() => {
    if (consumedId !== null) {
      runStore.release(chatId, consumedId);
    }
  }, [chatId, consumedId]);

  function handleSend(
    content: string,
    attachments: Attachment[],
    documents: DocumentAttachment[],
  ): boolean {
    if (status !== "ready" || pendingApproval) {
      return false;
    }
    if (runStore.startTurn(chatId, { content, attachments, documents }) === null) {
      // A run got in between the render that enabled the composer and the
      // press. The reply now streaming is on screen; the composer keeps the
      // draft for after it.
      return false;
    }
    setError(null);
    // The one place that overrules the reader. Sending is asking for the answer,
    // so it takes them back down however far up they had scrolled — and
    // `ignoreEscapes` holds them there for the trip rather than letting the
    // scroll they are still coasting from cancel it.
    void scrollToBottom({ ignoreEscapes: true });
    return true;
  }

  if (status === "not-found") {
    return (
      <Flex h="100%" align="center" justify="center">
        <Text fz="sm" c="dimmed">
          {t("chat.notFound")}
        </Text>
      </Flex>
    );
  }

  const streaming = shown?.status === "streaming";
  // An entry exists before it holds anything — just attached, or failed before
  // the first chunk — and an empty bubble under the user's turn promises a reply
  // that is not coming. While it streams the running indicator is the right
  // answer to that; settled and still empty, there is nothing to draw.
  const live = shown && (streaming || shown.live !== EMPTY_TURN) ? shown.live : null;
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
        <Box
          pb="xs"
          mb="sm"
          style={{ borderBottom: "1px solid var(--studio-border)" }}
        >
          <Group gap="xs" className={classes.column}>
            <Badge variant="outline" color="gray">{t("chat.kind")}</Badge>
            <Badge color={BADGE.owned} radius="xl">
              {chat.projectName}
            </Badge>
          </Group>
        </Box>
      )}
      <Box style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <ScrollArea viewportRef={scrollRef} h="100%" pb="md">
          {/* The element the stick-to-bottom ResizeObserver watches. It has to be
              inside the viewport and wrap everything that grows. */}
          <div ref={contentRef}>
            <Stack gap="sm" className={classes.column}>
              {status === "loading" && !shown && (
                <Text fz="sm" c="dimmed">
                  {t("common.loading")}
                </Text>
              )}
              {status === "load-error" && (
                <Alert color="red" variant="light">
                  <Stack gap="xs" align="flex-start">
                    <Text fz="sm">{t("chat.loadFailed")}</Text>
                    <Button size="xs" variant="light" color="red" onClick={() => {
                      setStatus("loading");
                      setLoadAttempt((attempt) => attempt + 1);
                    }}>
                      {t("error.retry")}
                    </Button>
                  </Stack>
                </Alert>
              )}
              {drawn.map((message) => (
                <MessageView
                  key={`${message.seq}`}
                  message={message}
                  {...(toolArgs.has(message.seq) ? { callArgs: toolArgs.get(message.seq) } : {})}
                  {...(durations.has(message.seq)
                    ? { durationMs: durations.get(message.seq) }
                    : {})}
                />
              ))}
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
              {live && (
                <LiveAssistant
                  turn={live}
                  running={streaming}
                  {...(shown?.startedAtMs !== undefined
                    ? { startedAtMs: shown.startedAtMs }
                    : {})}
                  {...(shown?.endedAtMs !== undefined ? { endedAtMs: shown.endedAtMs } : {})}
                />
              )}
              {pendingApproval && <PendingApproval
                key={`${chatId}:${pendingApproval.revision}`}
                chatId={chatId} pending={pendingApproval} disabled={streaming}
                onDecision={(decisions) => {
                  if (runStore.resumeApproval(chatId, { revision: pendingApproval.revision, decisions }) !== null) setError(null);
                }}
                onDiscarded={() => { if (showing.current === chatId) { setApprovalState(null); void syncFromServer({ tail: true }); } }}
              />}
            </Stack>
          </div>
        </ScrollArea>
        {/* Only while the reader has left the bottom. Nothing drags them back
            on its own any more, so this is how they say they want to follow
            along again — the affordance every chat surface pairs with that.
            Keyed on `isNearBottom`, which is pure geometry, rather than on
            `isAtBottom`, which stays true until the library is satisfied the
            reader *meant* to leave — and during a reply it never gets to
            decide, because it skips that judgement while the content resizes. */}
        {!isNearBottom && (
          <ActionIcon
            variant="filled"
            color="gray"
            radius="xl"
            size="lg"
            onClick={() => void scrollToBottom()}
            aria-label={t("chat.jumpToLatest")}
            className={classes.jump}
          >
            <IconArrowDown size={18} />
          </ActionIcon>
        )}
      </Box>
      <Box pt="sm" style={{ borderTop: "1px solid var(--studio-border)" }}>
        <Box className={classes.column}>
          {banner && (
            <Alert color="red" variant="light" mb="xs" py={6} px="sm" fz="xs">
              {banner}
            </Alert>
          )}
          <Composer
            onSend={handleSend}
            disabled={status !== "ready" || streaming || Boolean(pendingApproval)}
            busy={streaming}
            status={<RunningAgents paths={live?.authorPaths ?? []} />}
            {...(streaming && shown.runId ? { onStop: () => runStore.cancelRun(chatId) } : {})}
          />
        </Box>
      </Box>
    </Flex>
  );
}
