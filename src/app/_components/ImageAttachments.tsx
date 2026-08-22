"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /**
   * How many slots are already spoken for, counted as they are claimed rather
   * than as React commits them.
   *
   * There are three ways in now — the paperclip, a paste and a drop — and two
   * of them can land inside the same `await` of reading a file. Both calls
   * would then read the same `attachments.length`, both would decide they fit,
   * and the updater would silently drop the second batch past the cap with no
   * `attachError` to say so. Claiming against a ref closes that window.
   */
  const claimed = useRef({ images: 0, documents: 0 });

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
      //
      // Counted against the claim rather than the rendered length, so two
      // gestures resolving in the same tick cannot both spend the last slot.
      const imageRoom = Math.max(MAX_ATTACHMENTS - claimed.current.images, 0);
      const documentRoom = Math.max(MAX_DOCUMENTS - claimed.current.documents, 0);
      if (added.length > imageRoom) {
        failures.push(t("attach.tooManyImages", { count: MAX_ATTACHMENTS }));
      }
      if (addedDocuments.length > documentRoom) {
        failures.push(t("attach.tooManyDocuments", { count: MAX_DOCUMENTS }));
      }
      const takenImages = added.slice(0, imageRoom);
      const takenDocuments = addedDocuments.slice(0, documentRoom);
      claimed.current = {
        images: claimed.current.images + takenImages.length,
        documents: claimed.current.documents + takenDocuments.length,
      };
      setAttachments((prev) => [...prev, ...takenImages]);
      setDocuments((prev) => [...prev, ...takenDocuments]);
      if (failures.length > 0) {
        setAttachError(failures.join(" · "));
      }
    },
    // The rendered lengths are no longer read here, so this identity holds
    // across a staged file — which is what lets the composer memoise the
    // handlers built from it.
    [allowDocuments, t],
  );

  const removeAt = useCallback((index: number) => {
    claimed.current.images = Math.max(claimed.current.images - 1, 0);
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeDocumentAt = useCallback((index: number) => {
    claimed.current.documents = Math.max(claimed.current.documents - 1, 0);
    setDocuments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clear = useCallback(() => {
    claimed.current = { images: 0, documents: 0 };
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
  // The newest reader, held rather than closed over: see the dependency note
  // on `handlers` below.
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  // A run can start while a file is being dragged over the composer, and the
  // `dragleave` that would have balanced the counter is then a `dragleave` the
  // disabled handler ignores — leaving the depth above zero and the overlay
  // sitting on top of the textarea until some later drag happens to balance
  // it. Clearing on the flip is what bounds that to the frame it happens in.
  useEffect(() => {
    if (disabled) {
      reset();
    }
  }, [disabled, reset]);

  const handlers = useMemo(
    () => ({
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
      // The bookkeeping runs whether or not this is disabled *now*: the enter
      // that raised the counter may have happened while it was enabled, and a
      // leave that returns early is a counter that never comes back down.
      onDragLeave: (event: React.DragEvent) => {
        if (!draggingFiles(event.dataTransfer)) {
          return;
        }
        depth.current -= 1;
        if (depth.current <= 0) {
          reset();
        }
      },
      onDrop: (event: React.DragEvent) => {
        if (!draggingFiles(event.dataTransfer)) {
          return;
        }
        // Prevented and cleared even when disabled — the browser's own default
        // for an unhandled file drop is to navigate to the file, replacing the
        // console with it.
        event.preventDefault();
        reset();
        if (disabled) {
          return;
        }
        const files = transferredFiles(event.dataTransfer);
        if (files.length > 0) {
          onFilesRef.current(files);
        }
      },
    }),
    // `onFiles` is rebuilt by its caller every render, so it is deliberately
    // not a dependency: this hook is used by the chat composer, which
    // re-renders once per stream frame, and a new handler object per frame is
    // exactly the per-frame churn this view is careful about. The identity
    // held here calls whatever `onFiles` was current when the drop happened,
    // through the ref above.
    [disabled, reset],
  );

  return { dragging, handlers };
}

/**
 * Paste-to-attach: a screenshot on the clipboard becomes an attachment.
 *
 * **A clipboard carrying text is a text paste, even when it also carries a
 * picture.** Copying a spreadsheet range, a slide, a Figma frame or an image
 * with its caption puts `text/plain`, `text/html` *and* an `image/png` in one
 * transfer, so a file count alone would `preventDefault` the reader's text
 * away and stage a screenshot of it instead — losing what they meant to paste
 * and attaching something they did not ask for. Only a files-only clipboard,
 * which is what a screenshot and a copied file are, becomes an attachment.
 */
export function onFilePaste(onFiles: (files: File[]) => void, disabled = false) {
  return (event: React.ClipboardEvent) => {
    if (disabled) {
      return;
    }
    const types = Array.from(event.clipboardData?.types ?? []);
    if (types.some((type) => type.startsWith("text/"))) {
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
