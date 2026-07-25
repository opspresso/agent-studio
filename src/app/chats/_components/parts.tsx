"use client";

import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatShortDateTime } from "@/lib/date";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_ATTACHMENTS,
  attachmentSrc,
  readAttachment,
} from "../_lib/attachments";
import type { Attachment, ChatMessage, LiveImage, LiveTurn } from "../_lib/types";

function MessageTimestamp({ createdAt }: { createdAt: string }) {
  const formatted = formatShortDateTime(createdAt);
  if (!formatted) {
    return null;
  }
  return <time className="mt-0.5 block text-[11px] text-neutral-400">{formatted}</time>;
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="chat-markdown break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function ToolResultBlock({ content, label }: { content: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 bg-neutral-100 px-3 py-1.5 text-left text-xs font-medium text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <span className="text-neutral-400">{open ? "▾" : "▸"}</span>
        <span>{label ?? "Tool result"}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
          {content}
        </pre>
      )}
    </div>
  );
}

export function GeneratedImage({ src, alt }: { src: string; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className="max-w-[80%] rounded-md border border-neutral-200 dark:border-neutral-800"
    />
  );
}

export function liveImageSrc(image: LiveImage): string {
  return `data:${image.mimeType};base64,${image.b64}`;
}

export function AuthorBadge({ author }: { author: string }) {
  return (
    <span className="mb-1 inline-block rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
      via {author}
    </span>
  );
}

export function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {(message.images ?? []).map((image, index) => (
          <GeneratedImage key={`attached-${index}`} src={image.url} alt="Attached image" />
        ))}
        {message.content && (
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-brand px-4 py-2 text-sm text-white">
            {message.content}
          </div>
        )}
        <MessageTimestamp createdAt={message.createdAt} />
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="flex justify-start">
        <div className="w-full max-w-[80%]">
          <ToolResultBlock
            content={message.content}
            label={message.toolName ? `✅ tool result: ${message.toolName}` : undefined}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      {(message.images ?? []).map((image, index) => (
        <GeneratedImage
          key={`image-${index}`}
          src={image.url}
          alt={image.prompt ?? "Generated image"}
        />
      ))}
      <div className="max-w-[80%] rounded-2xl border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        <MarkdownContent content={message.content} />
      </div>
      <MessageTimestamp createdAt={message.createdAt} />
    </div>
  );
}

export function LiveAssistant({ turn }: { turn: LiveTurn }) {
  return (
    <div className="flex flex-col items-start gap-1">
      {turn.toolCalls.map((call, index) => (
        <div key={`call-${index}`} className="w-full max-w-[80%]">
          <ToolResultBlock content={call.args} label={`🔧 tool call: ${call.name}`} />
        </div>
      ))}
      {turn.tools.map((tool, index) => (
        <div key={`result-${index}`} className="w-full max-w-[80%]">
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
      <div className="max-w-[80%]">
        {turn.author && <AuthorBadge author={turn.author} />}
        <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
          {turn.text ? (
            <MarkdownContent content={turn.text} />
          ) : (
            <span className="text-neutral-400">Thinking…</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Staged image attachments for one turn. Owned by a hook so the two composers
 * (new chat, existing thread) share one set of limits and one error surface.
 */
export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setAttachError(null);
    const added: Attachment[] = [];
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        added.push(await readAttachment(file));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `${file.name}: unreadable`);
      }
    }
    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS - prev.length;
      if (added.length > room) {
        failures.push(`At most ${MAX_ATTACHMENTS} images per message`);
      }
      return [...prev, ...added.slice(0, Math.max(room, 0))];
    });
    if (failures.length > 0) {
      setAttachError(failures.join(" · "));
    }
  }, []);

  const removeAt = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setAttachError(null);
  }, []);

  return { attachments, attachError, addFiles, removeAt, clear };
}

export function AttachmentBar({
  attachments,
  attachError,
  onRemove,
}: {
  attachments: Attachment[];
  attachError: string | null;
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0 && !attachError) {
    return null;
  }
  return (
    <div className="mb-2 space-y-1">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <div key={`${attachment.name}-${index}`} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={attachmentSrc(attachment)}
                alt={attachment.name}
                className="h-16 w-16 rounded-md border border-neutral-200 object-cover dark:border-neutral-800"
              />
              <button
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${attachment.name}`}
                className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-neutral-800 text-xs leading-5 text-white hover:bg-neutral-700"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && <p className="text-xs text-red-600">{attachError}</p>}
    </div>
  );
}

export function AttachButton({
  onPick,
  disabled,
}: {
  onPick: (files: FileList | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        multiple
        className="hidden"
        onChange={(event) => {
          onPick(event.target.files);
          // Reset so picking the same file again still fires a change event.
          event.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="Attach images"
        title="Attach images"
        className="rounded-xl border border-neutral-300 px-3 py-2 text-sm text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        📎
      </button>
    </>
  );
}

export function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (content: string, attachments: Attachment[]) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const { attachments, attachError, addFiles, removeAt, clear } = useAttachments();

  function submit() {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled) {
      return;
    }
    setValue("");
    clear();
    onSend(trimmed, attachments);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <AttachmentBar attachments={attachments} attachError={attachError} onRemove={removeAt} />
      <div className="flex items-end gap-2">
        <AttachButton onPick={(files) => void addFiles(files)} disabled={disabled} />
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={placeholder ?? "Send a message…"}
          className="max-h-40 min-h-[42px] flex-1 resize-y rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-brand dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          type="submit"
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </form>
  );
}
