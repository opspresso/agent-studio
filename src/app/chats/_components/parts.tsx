"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Group,
  Image,
  Paper,
  Stack,
  Text,
  Typography,
} from "@mantine/core";
import { IconFileText } from "@tabler/icons-react";
import { formatShortDateTime } from "@/shared/date";
import { imageDataUrl } from "@/domain/llm/types";
import { useLocale, useT } from "@/app/_i18n/provider";
import { CopyButton } from "@/app/_components/CopyButton";
import { ProducedFile } from "@/app/_components/ProducedFile";
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
 */
export function GeneratedImage({ src, alt }: { src: string; alt: string }) {
  const [gone, setGone] = useState(false);
  const t = useT();
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
}: {
  message: ChatMessage;
  /** For a tool row: the arguments its call carried — see `storedToolArgs`. */
  callArgs?: string | undefined;
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
                  alt={t("chat.attachedImage")}
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
      {(message.images ?? []).flatMap((image, index) =>
        image.url
          ? [
              <GeneratedImage
                key={`image-${index}`}
                src={image.url}
                alt={image.prompt ?? t("chat.generatedImage")}
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
              />,
            ]
          : [],
      )}
      <div className={classes.answer}>
        <MarkdownContent content={message.content} />
      </div>
      <Group gap="xs" align="center">
        <MessageTimestamp createdAt={message.createdAt} />
        {message.content && (
          <span className={classes.actions}>
            <CopyButton text={message.content} />
          </span>
        )}
      </Group>
    </Stack>
  );
});

export function LiveAssistant({ turn }: { turn: LiveTurn }) {
  const t = useT();
  return (
    <Stack gap={4} align="flex-start">
      {turn.warnings.map((warning, index) => (
        <WarningNote key={`warning-${index}`} text={warning} />
      ))}
      {pairToolTraffic(turn.toolCalls, turn.tools).map((pair, index) => (
        <ToolRow key={`tool-${index}`} pair={pair} />
      ))}
      {turn.images.map((image, index) => (
        <GeneratedImage
          key={`image-${index}`}
          src={liveImageSrc(image)}
          alt={image.prompt ?? t("chat.generatedImage")}
        />
      ))}
      {turn.files.map((file, index) => (
        <ProducedFile key={`file-${index}`} name={file.name} byteSize={file.byteSize} />
      ))}
      <div className={classes.answer}>
        {turn.text ? (
          <MarkdownContent content={turn.text} />
        ) : (
          <Text fz="sm" c="dimmed">
            {t("chat.thinking")}
          </Text>
        )}
      </div>
    </Stack>
  );
}
