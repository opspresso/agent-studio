"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Code,
  Group,
  Image,
  Paper,
  Stack,
  Text,
  Textarea,
  Typography,
  UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconFileText, IconSend } from "@tabler/icons-react";
import { formatShortDateTime } from "@/shared/date";
import { imageDataUrl } from "@/domain/llm/types";
import { AttachButton, AttachmentBar, useAttachments } from "@/app/_components/ImageAttachments";
import type { Attachment } from "@/app/_lib/imageAttachments";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import type { ChatMessage, LiveImage, LiveTurn } from "../_lib/types";
import classes from "./parts.module.css";
import { SUBAGENT_COLOR } from "@/app/_components/badgeColors";

function MessageTimestamp({ createdAt }: { createdAt: string }) {
  const formatted = formatShortDateTime(createdAt);
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
 * Markdown inside a bubble. Mantine's `Typography` owns the element styles the
 * `.chat-markdown` stylesheet used to hand-write; only the outer bubble's
 * margin collapse and wrapping are ours.
 */
function MarkdownContent({ content }: { content: string }) {
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </Typography>
  );
}

export function ToolResultBlock({ content, label }: { content: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Paper withBorder radius="md" style={{ overflow: "hidden" }} my={4}>
      <UnstyledButton onClick={() => setOpen((prev) => !prev)} className={classes.toolToggle}>
        <Group gap="xs" wrap="nowrap">
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Text fz="xs" fw={500}>
            {label ?? "Tool result"}
          </Text>
        </Group>
      </UnstyledButton>
      {open && (
        <Code block fz="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {content}
        </Code>
      )}
    </Paper>
  );
}

export function GeneratedImage({ src, alt }: { src: string; alt: string }) {
  return <Image src={src} alt={alt} radius="md" maw="80%" />;
}

export function liveImageSrc(image: LiveImage): string {
  return imageDataUrl(image);
}

export function AuthorBadge({ path }: { path: string[] }) {
  return (
    <Badge color={SUBAGENT_COLOR} radius="xl" mb={4}>
      via {path.join(" → ")}
    </Badge>
  );
}

/** A binding the run could not use — shown live and again on reload. */
function WarningNote({ text }: { text: string }) {
  return (
    <Alert color="yellow" variant="light" py={6} px="sm" maw="80%" fz="xs">
      {text}
    </Alert>
  );
}

/** The assistant's bubble, shared by the persisted and the streaming views. */
function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <Paper withBorder radius="lg" px="md" py="xs" fz="sm">
      {children}
    </Paper>
  );
}

export function MessageView({ message }: { message: ChatMessage }) {
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
                title={document.note ? `Read ${document.note}` : undefined}
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
                  alt="Attached image"
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
    return (
      <Group justify="flex-start">
        <div style={{ width: "100%", maxWidth: "80%" }}>
          <ToolResultBlock
            content={message.content}
            label={
              message.toolName
                ? `✅ tool result: ${message.toolName}${message.author ? ` (via ${message.author})` : ""}`
                : undefined
            }
          />
        </div>
      </Group>
    );
  }

  return (
    <Stack gap={4} align="flex-start">
      {(message.warnings ?? []).map((warning, index) => (
        <WarningNote key={`warning-${index}`} text={warning} />
      ))}
      {(message.images ?? []).flatMap((image, index) =>
        image.url
          ? [
              <GeneratedImage
                key={`image-${index}`}
                src={image.url}
                alt={image.prompt ?? "Generated image"}
              />,
            ]
          : [],
      )}
      <div style={{ maxWidth: "80%" }}>
        <AssistantBubble>
          <MarkdownContent content={message.content} />
        </AssistantBubble>
      </div>
      <MessageTimestamp createdAt={message.createdAt} />
    </Stack>
  );
}

export function LiveAssistant({ turn }: { turn: LiveTurn }) {
  return (
    <Stack gap={4} align="flex-start">
      {turn.warnings.map((warning, index) => (
        <WarningNote key={`warning-${index}`} text={warning} />
      ))}
      {turn.toolCalls.map((call, index) => (
        <div key={`call-${index}`} style={{ width: "100%", maxWidth: "80%" }}>
          <ToolResultBlock content={call.args} label={`🔧 tool call: ${call.name}`} />
        </div>
      ))}
      {turn.tools.map((tool, index) => (
        <div key={`result-${index}`} style={{ width: "100%", maxWidth: "80%" }}>
          <ToolResultBlock
            content={tool.content}
            label={tool.name ? `✅ tool result: ${tool.name}` : undefined}
          />
        </div>
      ))}
      {turn.images.map((image, index) => (
        <GeneratedImage
          key={`image-${index}`}
          src={liveImageSrc(image)}
          alt={image.prompt ?? "Generated image"}
        />
      ))}
      <div style={{ maxWidth: "80%" }}>
        {turn.authorPaths.map((path) => (
          <AuthorBadge key={path.join(">")} path={path} />
        ))}
        <AssistantBubble>
          {turn.text ? (
            <MarkdownContent content={turn.text} />
          ) : (
            <Text fz="sm" c="dimmed">
              Thinking…
            </Text>
          )}
        </AssistantBubble>
      </div>
    </Stack>
  );
}

export function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (
    content: string,
    attachments: Attachment[],
    documents: DocumentAttachment[],
  ) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const { attachments, documents, attachError, addFiles, removeAt, removeDocumentAt, clear } =
    useAttachments({ documents: true });

  function submit() {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0 && documents.length === 0) || disabled) {
      return;
    }
    setValue("");
    clear();
    onSend(trimmed, attachments, documents);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <AttachmentBar
        attachments={attachments}
        documents={documents}
        attachError={attachError}
        onRemove={removeAt}
        onRemoveDocument={removeDocumentAt}
      />
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <AttachButton onPick={(files) => void addFiles(files)} disabled={disabled} documents />
        <Textarea
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          autosize
          minRows={1}
          maxRows={8}
          radius="xl"
          placeholder={placeholder ?? "Send a message…"}
          style={{ flex: 1 }}
        />
        <ActionIcon
          type="submit"
          variant="filled"
          size="input-sm"
          radius="xl"
          disabled={
            disabled || (!value.trim() && attachments.length === 0 && documents.length === 0)
          }
          aria-label="Send"
        >
          <IconSend size={18} />
        </ActionIcon>
      </Group>
    </form>
  );
}
