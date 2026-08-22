"use client";

import { useCallback, useRef, useState } from "react";
import { ActionIcon, Badge, Box, FileButton, Group, Image, Overlay, Stack, Text } from "@mantine/core";
import { IconFileText, IconPaperclip, IconX } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import {
  ACCEPTED_IMAGE_TYPES,
  attachmentSrc,
  readAttachment,
  type Attachment,
} from "../_lib/imageAttachments";
import {
  ACCEPTED_DOCUMENT_TYPES,
  isDocumentFile,
  readDocumentAttachment,
  type DocumentAttachment,
} from "../_lib/documentAttachments";
import { MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENTS } from "@/domain/llm/documentLimits";

/**
 * Staged attachments for one turn — shared by the chat composers and the project
 * run panel so every surface enforces one set of limits and reports rejections
 * the same way.
 *
 * Pass `documents: true` where a turn can carry files as well as pictures. The
 * run panel does not: its attachments are the source images an `image` project
 * edits, which is a different thing that happens to use the same picker.
 */
export function useAttachments({ documents: allowDocuments = false } = {}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const t = useT();

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      setAttachError(null);
      const added: Attachment[] = [];
      const addedDocuments: DocumentAttachment[] = [];
      const failures: string[] = [];
      for (const file of files) {
        try {
          // Routed by what the file is, so one paperclip takes both and neither
          // path has to explain itself to the person picking.
          if (allowDocuments && isDocumentFile(file)) {
            addedDocuments.push(await readDocumentAttachment(file));
          } else {
            added.push(await readAttachment(file));
          }
        } catch (error) {
          // A thrown `Error` carries the reader's own message (a size or type
          // refusal) and stays as written; the fallback is the only part this
          // component words itself.
          failures.push(
            error instanceof Error ? error.message : t("attach.unreadable", { name: file.name }),
          );
        }
      }
      // Reported from here, not from inside the updater: the updater runs after
      // the checks below, so a message pushed there would never be shown — what
      // is over the cap would just disappear.
      if (added.length > Math.max(MAX_ATTACHMENTS - attachments.length, 0)) {
        failures.push(t("attach.tooManyImages", { count: MAX_ATTACHMENTS }));
      }
      if (addedDocuments.length > Math.max(MAX_DOCUMENTS - documents.length, 0)) {
        failures.push(t("attach.tooManyDocuments", { count: MAX_DOCUMENTS }));
      }
      setAttachments((prev) => [
        ...prev,
        ...added.slice(0, Math.max(MAX_ATTACHMENTS - prev.length, 0)),
      ]);
      setDocuments((prev) => [
        ...prev,
        ...addedDocuments.slice(0, Math.max(MAX_DOCUMENTS - prev.length, 0)),
      ]);
      if (failures.length > 0) {
        setAttachError(failures.join(" · "));
      }
    },
    [allowDocuments, attachments.length, documents.length, t],
  );

  const removeAt = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeDocumentAt = useCallback((index: number) => {
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setDocuments([]);
    setAttachError(null);
  }, []);

  return {
    attachments,
    documents,
    attachError,
    addFiles,
    removeAt,
    removeDocumentAt,
    clear,
  };
}

/**
 * The files a paste or a drop carries, and nothing else.
 *
 * A transfer with no files is text — a copied paragraph, a dragged link — and
 * must keep its native behaviour, so the caller checks the length before
 * calling `preventDefault`. `dataTransfer.files` is the one list both gestures
 * fill: a screenshot pasted from the OS clipboard arrives there exactly as a
 * dragged file does, which is what lets one reader handle both.
 */
export function transferredFiles(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : [];
}

/** Whether a drag is carrying files, decided before it is over the target. */
function draggingFiles(data: DataTransfer | null): boolean {
  return Array.from(data?.types ?? []).includes("Files");
}

/**
 * Drag-and-drop for a region that stages attachments.
 *
 * `dragenter`/`dragleave` fire for every child the pointer crosses, so a plain
 * boolean flickers off the moment the cursor passes over the textarea inside
 * the drop zone. The depth counter is what makes the highlight survive the
 * crossing — it is the standard fix for a well-known DOM behaviour, not a
 * workaround for anything here.
 *
 * `onDragOver` must call `preventDefault` or the browser refuses the drop and
 * navigates to the file instead, which is the failure this hook exists to
 * avoid: the console would be replaced by whatever was dragged onto it.
 */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  const handlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (disabled || !draggingFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (disabled || !draggingFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: React.DragEvent) => {
      if (disabled || !draggingFiles(event.dataTransfer)) {
        return;
      }
      depth.current -= 1;
      if (depth.current <= 0) {
        reset();
      }
    },
    onDrop: (event: React.DragEvent) => {
      if (disabled || !draggingFiles(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      reset();
      const files = transferredFiles(event.dataTransfer);
      if (files.length > 0) {
        onFiles(files);
      }
    },
  };

  return { dragging, handlers };
}

/**
 * Paste-to-attach: a screenshot on the clipboard becomes an attachment.
 *
 * Text pastes fall through untouched — the guard is the file count, because
 * `preventDefault` on a text paste would swallow what the reader was pasting.
 */
export function onFilePaste(onFiles: (files: File[]) => void, disabled = false) {
  return (event: React.ClipboardEvent) => {
    if (disabled) {
      return;
    }
    const files = transferredFiles(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      onFiles(files);
    }
  };
}

/** The "drop here" wash drawn over a region while files are being dragged onto it. */
export function DropHint() {
  const t = useT();
  return (
    <Overlay color="var(--mantine-color-body)" backgroundOpacity={0.75} zIndex={2} radius="lg">
      <Group justify="center" align="center" h="100%">
        <Text fz="sm" fw={500} c="dimmed">
          {t("attach.drop")}
        </Text>
      </Group>
    </Overlay>
  );
}

export function AttachmentBar({
  attachments,
  documents = [],
  attachError,
  onRemove,
  onRemoveDocument,
}: {
  attachments: Attachment[];
  documents?: DocumentAttachment[];
  attachError: string | null;
  onRemove: (index: number) => void;
  onRemoveDocument?: (index: number) => void;
}) {
  const t = useT();
  if (attachments.length === 0 && documents.length === 0 && !attachError) {
    return null;
  }
  return (
    <Stack gap={4} mb="xs">
      {documents.length > 0 && (
        <Group gap="xs">
          {documents.map((document, index) => (
            <Badge
              key={`${document.name}-${index}`}
              variant="light"
              size="lg"
              leftSection={<IconFileText size={14} />}
              rightSection={
                onRemoveDocument && (
                  <ActionIcon
                    variant="transparent"
                    color="gray"
                    size="xs"
                    onClick={() => onRemoveDocument(index)}
                    aria-label={t("attach.remove", { name: document.name })}
                  >
                    <IconX size={12} />
                  </ActionIcon>
                )
              }
            >
              {document.name}
            </Badge>
          ))}
        </Group>
      )}
      {attachments.length > 0 && (
        <Group gap="xs">
          {attachments.map((attachment, index) => (
            <Box key={`${attachment.name}-${index}`} pos="relative">
              <Image
                src={attachmentSrc(attachment)}
                alt={attachment.name}
                w={64}
                h={64}
                radius="md"
                fit="cover"
              />
              <ActionIcon
                variant="filled"
                color="dark"
                radius="xl"
                size="xs"
                pos="absolute"
                top={-6}
                right={-6}
                onClick={() => onRemove(index)}
                aria-label={t("attach.remove", { name: attachment.name })}
              >
                <IconX size={12} />
              </ActionIcon>
            </Box>
          ))}
        </Group>
      )}
      {attachError && (
        <Text fz="xs" c="red">
          {attachError}
        </Text>
      )}
    </Stack>
  );
}

export function AttachButton({
  onPick,
  disabled,
  documents = false,
}: {
  onPick: (files: File[]) => void;
  disabled?: boolean;
  /** Offer documents alongside images; mirror what `useAttachments` was given. */
  documents?: boolean;
}) {
  // Clears the underlying input after each pick, so choosing the same file
  // again still fires a change event.
  const reset = useRef<() => void>(null);
  const t = useT();
  const label = documents ? t("attach.imagesOrDocuments") : t("attach.images");

  return (
    <FileButton
      resetRef={reset}
      onChange={(files) => {
        onPick(files);
        reset.current?.();
      }}
      accept={[...ACCEPTED_IMAGE_TYPES, ...(documents ? ACCEPTED_DOCUMENT_TYPES : [])].join(",")}
      multiple
    >
      {(props) => (
        <ActionIcon
          {...props}
          variant="default"
          size="input-sm"
          disabled={disabled}
          aria-label={label}
          title={label}
        >
          <IconPaperclip size={18} />
        </ActionIcon>
      )}
    </FileButton>
  );
}
