"use client";

import { useCallback, useMemo, useState } from "react";
import { ActionIcon, Group, Stack, Text, Textarea } from "@mantine/core";
import { IconPlayerStopFilled, IconSend } from "@tabler/icons-react";
import {
  AttachButton,
  AttachmentBar,
  DropHint,
  onFilePaste,
  useAttachments,
  useFileDrop,
} from "@/app/_components/ImageAttachments";
import { useT } from "@/app/_i18n/provider";
import type { Attachment } from "@/app/_lib/imageAttachments";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import { isSubmitEnter } from "@/app/_lib/modEnter";

/**
 * The one composer.
 *
 * New and existing chats share this component. Their only layout difference is
 * the `leading` slot: a project picker before a chat exists, and nothing after.
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
   * enabled the composer and the press, so clearing before acceptance can lose
   * a typed message.
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
  const t = useT();
  const {
    attachments,
    documents,
    attachError,
    reading,
    addFiles,
    removeAt,
    removeDocumentAt,
    clear,
  } = useAttachments({ documents: true });

  const empty = !value.trim() && attachments.length === 0 && documents.length === 0;

  // Both gestures land on the same reader as the paperclip: `addFiles` is what
  // decides which of a dropped batch is a picture and which is a document, and
  // what reports the ones over the cap. Neither is offered while a reply is
  // running, for the same reason the send button is not.
  const attach = useCallback((files: File[]) => void addFiles(files), [addFiles]);
  const { dragging, handlers } = useFileDrop(attach, disabled);
  const onPaste = useMemo(() => onFilePaste(attach, disabled), [attach, disabled]);

  function submit() {
    if (empty || disabled || reading) {
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
      {...handlers}
      style={{ position: "relative", padding: "var(--mantine-spacing-sm)", border: "1px solid var(--studio-border)", borderRadius: "var(--mantine-radius-lg)", background: "var(--studio-surface-raised)" }}
    >
      {dragging && <DropHint />}
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
            aria-label={t("chat.messageLabel")}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (isSubmitEnter(event) && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            autosize
            minRows={2}
            maxRows={8}
            radius="md"
            placeholder={placeholder ?? t("chat.placeholder")}
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
              aria-label={t("chat.stop")}
            >
              <IconPlayerStopFilled size={16} />
            </ActionIcon>
          ) : (
            <ActionIcon
              type="submit"
              variant="filled"
              color="brand"
              size="input-sm"
              radius="xl"
              loading={disabled || reading}
              disabled={disabled || reading || empty}
              aria-label={t("chat.send")}
            >
              <IconSend size={18} />
            </ActionIcon>
          )}
        </Group>
        <Text fz="xs" c="dimmed" ta="right">{t("chat.inputHint")}</Text>
      </Stack>
    </form>
  );
}
