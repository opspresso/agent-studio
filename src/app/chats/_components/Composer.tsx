"use client";

import { useState } from "react";
import { ActionIcon, Group, Stack, Textarea } from "@mantine/core";
import { IconPlayerStopFilled, IconSend } from "@tabler/icons-react";
import { AttachButton, AttachmentBar, useAttachments } from "@/app/_components/ImageAttachments";
import type { Attachment } from "@/app/_lib/imageAttachments";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";

/**
 * The one composer.
 *
 * There used to be two: this one, and a copy inlined in `NewChatPanel` that had
 * grown its own project picker and its own Stop button. They had already drifted
 * — only one of them cleared its attachments on send — and a redesign of the
 * chat surface would have meant restyling both and keeping them in step by hand.
 *
 * The differences between the two turned out to be one slot above the input,
 * which is what `leading` is: a project picker on a chat that does not exist
 * yet, and nothing at all on one that does.
 */
export function Composer({
  onSend,
  onStop,
  disabled,
  placeholder,
  leading,
  status,
}: {
  /**
   * Returns whether the send was accepted. `false` keeps the draft — text and
   * attachments — exactly as typed: a run can start between the render that
   * enabled the composer and the press, and clearing before asking is how a
   * typed message used to vanish into that window.
   */
  onSend: (
    content: string,
    attachments: Attachment[],
    documents: DocumentAttachment[],
  ) => boolean;
  /**
   * Present while a reply is running. It takes the send button's place because
   * it is the only way to end a run: closing the tab no longer does, so a reply
   * nobody wants would otherwise hold a slot until the run deadline.
   */
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Above the input: the project picker, on a chat that does not exist yet. */
  leading?: React.ReactNode;
  /**
   * Between the two: who is answering right now. It lives here rather than in
   * the thread because it appears and disappears as a run hands off between
   * agents, and a row that comes and goes *inside* the scroll container shoves
   * the reply around while the reader is trying to read it.
   */
  status?: React.ReactNode;
}) {
  const [value, setValue] = useState("");
  const { attachments, documents, attachError, addFiles, removeAt, removeDocumentAt, clear } =
    useAttachments({ documents: true });

  const empty = !value.trim() && attachments.length === 0 && documents.length === 0;

  function submit() {
    if (empty || disabled) {
      return;
    }
    if (!onSend(value.trim(), attachments, documents)) {
      return;
    }
    setValue("");
    clear();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack gap="xs">
        {leading}
        {status}
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
          {onStop ? (
            <ActionIcon
              type="button"
              variant="filled"
              color="red"
              size="input-sm"
              radius="xl"
              onClick={onStop}
              aria-label="Stop"
            >
              <IconPlayerStopFilled size={16} />
            </ActionIcon>
          ) : (
            <ActionIcon
              type="submit"
              variant="filled"
              size="input-sm"
              radius="xl"
              loading={disabled}
              disabled={disabled || empty}
              aria-label="Send"
            >
              <IconSend size={18} />
            </ActionIcon>
          )}
        </Group>
      </Stack>
    </form>
  );
}
