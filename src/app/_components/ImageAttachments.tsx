"use client";

import { useCallback, useRef, useState } from "react";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_ATTACHMENTS,
  attachmentSrc,
  readAttachment,
  type Attachment,
} from "../_lib/imageAttachments";

/**
 * Staged image attachments for one turn — shared by the chat composers and the
 * project run panel so every surface enforces one set of limits and reports
 * rejections the same way.
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
  label,
}: {
  onPick: (files: FileList | null) => void;
  disabled?: boolean;
  label?: string;
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
        {label ?? "📎"}
      </button>
    </>
  );
}
