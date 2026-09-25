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
import { MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENTS } from "@/domain/llm/documentLimits";

/**
 * A group of concurrent file reads that one clear can retire together.
 *
 * Unlike `createLatestOnly`, starting a second read does not retire the first:
 * a paste and a drop may both be valid. Only clearing the draft moves the
 * epoch, so neither read can add itself to the next message when it finishes.
 */
export function createAttachmentReadEpoch(): {
  capture: () => () => boolean;
  invalidate: () => void;
} {
  let epoch = 0;
  return {
    capture: () => {
      const captured = epoch;
      return () => captured === epoch;
    },
    invalidate: () => {
      epoch += 1;
    },
  };
}

/**
 * Staged attachments for one turn — shared by the chat composers and the agent
 * run panel so every surface enforces one set of limits and reports rejections
 * the same way.
 *
 * Pass `documents: true` where a turn can carry files as well as pictures.
 */
export function useAttachments({ documents: allowDocuments = false } = {}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [attachErrors, setAttachErrors] = useState<string[]>([]);
  const [pendingReads, setPendingReads] = useState(0);
  const t = useT();
  const readEpoch = useRef(createAttachmentReadEpoch());
  const activeReads = useRef(new Set<AbortController>());
  const cancelReads = useCallback(() => {
    readEpoch.current.invalidate();
    for (const controller of activeReads.current) controller.abort();
    activeReads.current.clear();
  }, []);
  useEffect(() => cancelReads, [cancelReads]);
  /**
   * Staged files plus reservations for pending reads. Claim before reading
   * bytes, so overlapping picker, paste and drop gestures share the same cap.
   */
  const claimed = useRef({ images: 0, documents: 0 });
  const staged = useRef({ images: [] as Attachment[], documents: [] as DocumentAttachment[] });

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      const isCurrent = readEpoch.current.capture();
      // Clearing replaces the claim object. An old read's release must never
      // return a slot reserved by the next draft.
      const claims = claimed.current;
      const controller = new AbortController();
      if (activeReads.current.size === 0) setAttachErrors([]);
      activeReads.current.add(controller);
      setPendingReads((current) => current + 1);
      const added: Attachment[] = [];
      const addedDocuments: DocumentAttachment[] = [];
      const failures = new Set<string>();
      let committed = false;
      try {
        for (const file of files) {
          if (!isCurrent()) return;
          // Routed by what the file is, before claiming that type's slot.
          const document = allowDocuments && isDocumentFile(file);
          const kind = document ? "documents" : "images";
          const limit = document ? MAX_DOCUMENTS : MAX_IMAGES_PER_TURN;
          if (claims[kind] >= limit) {
            failures.add(t(document ? "attach.tooManyDocuments" : "attach.tooManyImages", { count: limit }));
            continue;
          }
          claims[kind] += 1;
          try {
            if (document) {
              addedDocuments.push(await readDocumentAttachment(file, controller.signal));
            } else {
              added.push(await readAttachment(file, controller.signal));
            }
          } catch (error) {
            claims[kind] -= 1;
            // A thrown `Error` carries the reader's own message (a size or type
            // refusal) and stays as written; the fallback is the only part this
            // component words itself.
            failures.add(
              error instanceof Error ? error.message : t("attach.unreadable", { name: file.name }),
            );
          }
        }
        if (!isCurrent()) {
          return;
        }
        if (added.length > 0) {
          staged.current.images = [...staged.current.images, ...added];
          setAttachments(staged.current.images);
        }
        if (addedDocuments.length > 0) {
          staged.current.documents = [...staged.current.documents, ...addedDocuments];
          setDocuments(staged.current.documents);
        }
        committed = true;
        if (failures.size > 0) {
          setAttachErrors((current) => [...new Set([...current, ...failures])]);
        }
      } finally {
        if (!committed) {
          claims.images -= added.length;
          claims.documents -= addedDocuments.length;
        }
        activeReads.current.delete(controller);
        if (isCurrent()) {
          setPendingReads((current) => Math.max(current - 1, 0));
        }
      }
    },
    // The rendered lengths are no longer read here, so this identity holds
    // across a staged file — which is what lets the composer memoise the
    // handlers built from it.
    [allowDocuments, t],
  );

  const removeAt = useCallback((index: number) => {
    if (!staged.current.images[index]) return;
    claimed.current.images -= 1;
    staged.current.images = staged.current.images.filter((_, i) => i !== index);
    setAttachments(staged.current.images);
  }, []);

  const removeDocumentAt = useCallback((index: number) => {
    if (!staged.current.documents[index]) return;
    claimed.current.documents -= 1;
    staged.current.documents = staged.current.documents.filter((_, i) => i !== index);
    setDocuments(staged.current.documents);
  }, []);

  const clear = useCallback(() => {
    cancelReads();
    claimed.current = { images: 0, documents: 0 };
    staged.current = { images: [], documents: [] };
    setPendingReads(0);
    setAttachments([]);
    setDocuments([]);
    setAttachErrors([]);
  }, [cancelReads]);

  return {
    attachments,
    documents,
    attachError: attachErrors.length > 0 ? attachErrors.join(" · ") : null,
    reading: pendingReads > 0,
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
 * Paste-to-attach: a picture or a file on the clipboard becomes an attachment.
 *
 * **`text/plain` is what decides, because it is the only thing a textarea can
 * receive.** Copying a spreadsheet range, a slide or a Figma frame puts
 * `text/plain`, `text/html` *and* an `image/png` in one transfer, and there
 * the reader means the words: staging the rendered picture instead would lose
 * what they copied and attach something they never asked for. So a clipboard
 * carrying text stays a text paste.
 *
 * Every other type beside the file is a *description* of that file, not
 * something anybody can paste as words — Chrome's "Copy image", and the same
 * gesture in Slack or Notion, put an `<img>` tag in `text/html` next to the
 * bytes and no `text/plain` at all. Refusing those (which reading any `text/*`
 * as text did) made the paste do **nothing whatsoever**: no attachment,
 * because we returned, and no text either, because there was none to insert.
 * A screenshot and a copied file arrive with no text type at all and have
 * always worked; this is the same gesture with a caption attached.
 */
export function onFilePaste(onFiles: (files: File[]) => void, disabled = false) {
  return (event: React.ClipboardEvent) => {
    if (disabled) {
      return;
    }
    const files = transferredFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    const types = Array.from(event.clipboardData?.types ?? []);
    if (types.includes("text/plain")) {
      return;
    }
    event.preventDefault();
    onFiles(files);
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
