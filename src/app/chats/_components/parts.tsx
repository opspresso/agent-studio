"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Group,
  Image,
  Loader,
  Paper,
  Stack,
  Text,
  Typography,
} from "@mantine/core";
import { IconFileText } from "@tabler/icons-react";
import { formatShortDateTime } from "@/shared/date";
import { formatDuration, formatSeconds } from "@/app/_lib/duration";
import { imageDataUrl } from "@/domain/llm/types";
import { useLocale, useT } from "@/app/_i18n/provider";
import { CopyButton } from "@/app/_components/CopyButton";
import { useImageViewer } from "@/app/_components/ImageViewer";
import { ProducedFile } from "@/app/_components/ProducedFile";
import { ReasoningRow } from "@/app/_components/ReasoningRow";
import { ToolRow } from "@/app/_components/ToolRow";
import { pairToolTraffic } from "@/app/_lib/toolPairs";
import type { ToolChatMessage } from "@/domain/chat/types";
import type { ChatMessage, LiveImage, LiveTurn } from "../_lib/types";
import classes from "./parts.module.css";
import { SUBAGENT_COLOR } from "@/app/_components/badgeColors";

function MessageTimestamp({ createdAt }: { createdAt: string }) {
  const locale = useLocale();
  const formatted = formatShortDateTime(createdAt, locale);
  if (!formatted) {
    return null;
  }
  return (
    <Text component="time" fz={11} c="dimmed" mt={2}>
      {formatted}
    </Text>
  );
}

/**
 * How long the answer above took.
 *
 * Beside the timestamp rather than under the reply: the two are the same kind of
 * fact about the turn — when it landed, and what it cost to wait for — and a
 * reader scanning back through a conversation reads them together.
 */
function AnswerDuration({ durationMs }: { durationMs: number }) {
  const t = useT();
  const formatted = formatDuration(durationMs, t);
  return (
    <Text fz={11} c="dimmed" mt={2} title={t("chat.answeredIn", { duration: formatted })}>
      {/* A separator, because the timestamp sits in an identical `Text` right
          beside it and two dimmed numbers with a gap between them read as one
          run-on string. */}
      {"· "}
      {formatted}
    </Text>
  );
}

/**
 * Markdown inside a message. Mantine's `Typography` owns the element styles the
 * `.chat-markdown` stylesheet used to hand-write; only the wrapping and the
 * outer margin collapse are ours.
 */
function MarkdownContent({ content }: { content: string }) {
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </Typography>
  );
}

/**
 * A stored tool row.
 *
 * `args` comes from the assistant message that declared the call, which the
 * thread attaches before rendering — without it a reloaded conversation can only
 * say `Skill`, never which skill, because the arguments live on the call and the
 * call is not what was stored here.
 */
function StoredToolRow({
  message,
  callArgs,
}: {
  message: ToolChatMessage;
  callArgs?: string | undefined;
}) {
  return (
    <ToolRow
      pair={{
        name: message.toolName ?? "tool",
        ...(callArgs === undefined ? {} : { args: callArgs }),
        content: message.content,
        author: message.author,
      }}
    />
  );
}

/**
 * An image with its space reserved before it loads.
 *
 * Without the ratio the row is zero-high until the bytes arrive and then jumps
 * to full size, shoving everything below it — which during a reply is the text
 * the reader is in the middle of.
 *
 * The fallback is for bytes that are no longer there. A signed URL is minted
 * offline and never checks that the object exists, so an image the bucket's
 * lifecycle rule swept — or that someone deleted from the artifacts gallery —
 * fails at fetch time and would otherwise render as a broken icon with nothing
 * said. That case predates the gallery: retention has always been able to
 * outlive a transcript.
 *
 * A click opens it in the shared viewer, where another click shows it at its
 * own pixel size. `label` names what it is ("Generated image", "Attached
 * image") and heads the viewer; the `prompt`, when there is one, is the
 * picture's alt text here and its caption there — never its title, which is
 * where a paragraph does not belong.
 */
export function GeneratedImage({
  src,
  label,
  prompt,
}: {
  src: string;
  label: string;
  prompt?: string;
}) {
  const [gone, setGone] = useState(false);
  const t = useT();
  const view = useImageViewer();
  const alt = prompt ?? label;
  return (
    <Box maw="80%" w="100%" style={{ aspectRatio: "1 / 1" }}>
      {gone ? (
        <Paper
          withBorder
          radius="md"
          h="100%"
          w="100%"
          p="md"
          style={{ display: "grid", placeItems: "center" }}
        >
          <Text size="sm" c="dimmed" ta="center">
            {t("chat.imageGone")}
          </Text>
        </Paper>
      ) : (
        <Image
          src={src}
          alt={alt}
          radius="md"
          h="100%"
          w="100%"
          fit="contain"
          onClick={() =>
            view({ src, alt, title: label, ...(prompt ? { caption: prompt } : {}) })
          }
          style={{ cursor: "zoom-in" }}
          onError={() => setGone(true)}
        />
      )}
    </Box>
  );
}

export function liveImageSrc(image: LiveImage): string {
  return imageDataUrl(image);
}

/**
 * Who is answering, right now. Rendered by the composer rather than inside the
 * thread: a run hands off between agents repeatedly, and a row that appears and
 * disappears inside the scroll container shoves the reply while it is being read.
 */
export function RunningAgents({ paths }: { paths: string[][] }) {
  const t = useT();
  if (paths.length === 0) {
    return null;
  }
  return (
    <Group gap={4}>
      {paths.map((path) => (
        <Badge key={path.join(">")} color={SUBAGENT_COLOR} radius="xl">
          {t("chat.via", { path: path.join(" → ") })}
        </Badge>
      ))}
    </Group>
  );
}

/** A binding the run could not use — shown live and again on reload. */
function WarningNote({ text }: { text: string }) {
  return (
    <Alert color="yellow" variant="light" py={6} px="sm" fz="xs" w="100%">
      {text}
    </Alert>
  );
}

/**
 * One stored message.
 *
 * Memoised, and the thread hands it reference-stable messages so the memo can
 * hold: a reply streams through the store dozens of times a second, and every
 * one of those renders used to walk the whole conversation and re-parse each
 * message's markdown from scratch. Forty messages made that a thousand-odd
 * parses a second, which is the jank the streamed reply was juddering through.
 * Nothing here depends on the turn in flight, so none of it needs redrawing
 * while one arrives.
 */
export const MessageView = memo(function MessageView({
  message,
  callArgs,
  durationMs,
}: {
  message: ChatMessage;
  /** For a tool row: the arguments its call carried — see `storedToolArgs`. */
  callArgs?: string | undefined;
  /** For an assistant row: the wait it ended — see `answerDurations`. */
  durationMs?: number | undefined;
}) {
  // `memo` compares props, and the locale is not one — but a context change
  // re-renders a consumer regardless of the memo, so switching language still
  // redraws every message.
  const t = useT();

  if (message.role === "user") {
    return (
      <Stack gap={4} align="flex-end">
        {/* The file itself is never stored — only the text read out of it — so
            what a reader gets back is the name they attached and how much of it
            was read. Silence here would make an attachment look like it never
            happened on the next page load. */}
        {(message.documents ?? []).length > 0 && (
          <Group gap="xs" justify="flex-end">
            {(message.documents ?? []).map((document, index) => (
              <Badge
                key={`document-${index}`}
                variant="light"
                size="lg"
                leftSection={<IconFileText size={14} />}
                title={
                  document.note ? t("chat.documentRead", { note: document.note }) : undefined
                }
              >
                {document.name}
                {document.note ? ` · ${document.note}` : ""}
              </Badge>
            ))}
          </Group>
        )}
        {/* `url` is always set on the wire: the API resolves stored keys to
            signed addresses and drops what it could not sign. */}
        {(message.images ?? []).flatMap((image, index) =>
          image.url
            ? [
                <GeneratedImage
                  key={`attached-${index}`}
                  src={image.url}
                  label={t("chat.attachedImage")}
                />,
              ]
            : [],
        )}
        {message.content && (
          <Paper radius="lg" px="md" py="xs" bg="var(--mantine-primary-color-filled)" maw="80%">
            <Text fz="sm" c="white" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {message.content}
            </Text>
          </Paper>
        )}
        <MessageTimestamp createdAt={message.createdAt} />
      </Stack>
    );
  }

  if (message.role === "tool") {
    return <StoredToolRow message={message} {...(callArgs === undefined ? {} : { callArgs })} />;
  }

  return (
    <Stack gap={4} align="flex-start" className={classes.turn}>
      {(message.warnings ?? []).map((warning, index) => (
        <WarningNote key={`warning-${index}`} text={warning} />
      ))}
      {/* Where it happened: the thinking came before the answer. Closed until
          clicked — no `streaming` here, since this turn is over. */}
      {message.reasoning && (
        <ReasoningRow text={message.reasoning} tokens={message.reasoningTokens} />
      )}
      {(message.images ?? []).flatMap((image, index) =>
        image.url
          ? [
              <GeneratedImage
                key={`image-${index}`}
                src={image.url}
                label={t("chat.generatedImage")}
                {...(image.prompt ? { prompt: image.prompt } : {})}
              />,
            ]
          : [],
      )}
      {/* Same rule as the images above: `url` is set by the read path, which
          drops whatever it could not sign rather than offering a dead link. */}
      {(message.files ?? []).flatMap((file, index) =>
        file.url
          ? [
              <ProducedFile
                key={`file-${index}`}
                name={file.name}
                url={file.url}
                byteSize={file.byteSize}
                mimeType={file.mimeType}
                artifactId={file.artifactId}
              />,
            ]
          : [],
      )}
      <div className={classes.answer}>
        <MarkdownContent content={message.content} />
      </div>
      <Group gap="xs" align="center">
        <MessageTimestamp createdAt={message.createdAt} />
        {durationMs !== undefined && <AnswerDuration durationMs={durationMs} />}
        {message.content && (
          <span className={classes.actions}>
            <CopyButton text={message.content} />
          </span>
        )}
      </Group>
    </Stack>
  );
});

/**
 * Whole seconds since `startedAtMs`, ticking as each one turns over.
 *
 * Its own hook so the re-render it schedules lands on the stopwatch and nothing
 * else. Put on `LiveAssistant` instead, every tick would re-render the answer
 * beside it — and re-parse its markdown — which is the cost the store's
 * collection window exists to avoid paying per frame.
 *
 * The next tick is scheduled onto the boundary rather than a second from now,
 * and that is not tidiness. A fixed interval starts out of phase with
 * `startedAtMs` and then accumulates whatever the main thread owes it — this
 * view re-parses a growing answer on the store's 50-200ms window, so ordinary
 * lateness compounds until a second is skipped outright and the reader watches
 * `12s` become `14s`, which reads as a stalled page. Re-aiming each time also
 * keeps the last painted frame equal to what the settled badge will say.
 */
function useElapsedSeconds(startedAtMs: number): number {
  const [seconds, setSeconds] = useState(() => (Date.now() - startedAtMs) / 1000);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const elapsed = Date.now() - startedAtMs;
      setSeconds(elapsed / 1000);
      // A whole second past the one just shown. `elapsed` can be negative if
      // the clock steps back mid-run, and `1000 - negative % 1000` is over a
      // second rather than under — clamped, so the clock keeps ticking.
      timer = setTimeout(tick, Math.max(50, 1000 - (((elapsed % 1000) + 1000) % 1000)));
    };
    // Once on the way in as well: the first boundary is up to a second away,
    // and a turn re-rendered mid-run would otherwise hold a stale number.
    tick();
    return () => clearTimeout(timer);
  }, [startedAtMs]);
  return seconds;
}

function RunStopwatch({ startedAtMs }: { startedAtMs: number }) {
  const t = useT();
  const seconds = useElapsedSeconds(startedAtMs);
  return (
    // Outside the status region, and hidden from the accessibility tree: a
    // number that changes every second inside a live region is announced over
    // everything else for the length of the reply. What the region should say —
    // that the run started — is said by the label, which does not change.
    <Text fz="xs" c="dimmed" aria-hidden fw={500}>
      {formatSeconds(seconds, t)}
    </Text>
  );
}

/**
 * How tall the line under the answer is, whichever of its three states is in it.
 *
 * Reserved rather than left to the content, because this line is inside the
 * scroll container: it goes from spinner to settled duration to nothing at all
 * as the run finishes and the stored turn replaces it, and a row that changes
 * height there shoves the text a reader is in the middle of. The same reason
 * `RunningAgents` is drawn by the composer instead of here.
 */
const PROGRESS_LINE_HEIGHT = 22;

/**
 * That the run is working, and for how long.
 *
 * It replaced a static "Thinking…", which said nothing after the first second —
 * a reply that took a minute looked identical to one that had hung. The spinner
 * is what makes it read as *running* rather than as a line of text that happens
 * to be there, and the stopwatch is what makes a long wait legible as progress.
 *
 * Drawn under the answer rather than in place of it, so it stays visible once
 * the first token lands: the run is still going, and the reader watching a tool
 * call finish wants the same two facts they wanted before it started.
 */
function RunProgress({ startedAtMs }: { startedAtMs?: number | undefined }) {
  const t = useT();
  return (
    <Group gap={8} align="center" h={PROGRESS_LINE_HEIGHT}>
      <Group gap={8} align="center" role="status">
        <Loader size={12} type="dots" />
        <Text fz="xs" c="dimmed">
          {t("chat.running")}
        </Text>
      </Group>
      {startedAtMs !== undefined && <RunStopwatch startedAtMs={startedAtMs} />}
    </Group>
  );
}

export function LiveAssistant({
  turn,
  running,
  startedAtMs,
  endedAtMs,
}: {
  turn: LiveTurn;
  /** False once the stream ended but the turn is still on screen. */
  running: boolean;
  startedAtMs?: number | undefined;
  endedAtMs?: number | undefined;
}) {
  const t = useT();
  return (
    <Stack gap={4} align="flex-start">
      {turn.warnings.map((warning, index) => (
        <WarningNote key={`warning-${index}`} text={warning} />
      ))}
      {/* Open while the model is still thinking and has said nothing, so a long
          silence shows what is filling it; it folds away as the answer starts,
          unless the reader has taken the panel over. */}
      <ReasoningRow
        // Keyed on the turn: the panel keeps whether the reader opened or
        // collapsed it, and without a new identity per turn one collapse would
        // switch off the auto-open for the rest of the session.
        key={`reasoning-${startedAtMs ?? 0}`}
        text={turn.reasoning}
        {...(turn.reasoningTokens > 0 ? { tokens: turn.reasoningTokens } : {})}
        streaming={running && turn.text === "" && turn.reasoning !== ""}
      />
      {pairToolTraffic(turn.toolCalls, turn.tools).map((pair, index) => (
        <ToolRow key={`tool-${index}`} pair={pair} />
      ))}
      {turn.images.map((image, index) => (
        <GeneratedImage
          key={`image-${index}`}
          src={liveImageSrc(image)}
          label={t("chat.generatedImage")}
          {...(image.prompt ? { prompt: image.prompt } : {})}
        />
      ))}
      {turn.files.map((file, index) => (
        <ProducedFile
          key={`file-${index}`}
          name={file.name}
          byteSize={file.byteSize}
          mimeType={file.mimeType}
          artifactId={file.artifactId}
        />
      ))}
      {turn.text && (
        <div className={classes.answer}>
          <MarkdownContent content={turn.text} />
        </div>
      )}
      {running ? (
        <RunProgress startedAtMs={startedAtMs} />
      ) : (
        // The stored message carries this turn's own badge, but only once the
        // retire's fetch has come back. Measured here as well, the number does
        // not blink out at the finish — and it is the only one a reader gets in
        // the minute a failing retire leaves this turn drawn from the live
        // entry. Held to the same rule as the stored badge: a negative gap is a
        // clock that stepped back, and `0s` would be a wrong answer where
        // silence is merely no answer.
        <Group h={PROGRESS_LINE_HEIGHT} align="center">
          {startedAtMs !== undefined && endedAtMs !== undefined && endedAtMs >= startedAtMs && (
            <AnswerDuration durationMs={endedAtMs - startedAtMs} />
          )}
        </Group>
      )}
    </Stack>
  );
}
