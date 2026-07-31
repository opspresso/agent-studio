"use client";

import { useCallback, useRef, useState } from "react";
import { ActionIcon, Badge, Box, FileButton, Group, Image, Stack, Text } from "@mantine/core";
import { IconFileText, IconPaperclip, IconX } from "@tabler/icons-react";
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
          failures.push(error instanceof Error ? error.message : `${file.name}: unreadable`);
        }
      }
      // Reported from here, not from inside the updater: the updater runs after
      // the checks below, so a message pushed there would never be shown — what
      // is over the cap would just disappear.
      if (added.length > Math.max(MAX_ATTACHMENTS - attachments.length, 0)) {
        failures.push(`At most ${MAX_ATTACHMENTS} images per message`);
      }
      if (addedDocuments.length > Math.max(MAX_DOCUMENTS - documents.length, 0)) {
        failures.push(`At most ${MAX_DOCUMENTS} documents per message`);
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
    [allowDocuments, attachments.length, documents.length],
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
                    aria-label={`Remove ${document.name}`}
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
                aria-label={`Remove ${attachment.name}`}
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
          aria-label={documents ? "Attach images or documents" : "Attach images"}
          title={documents ? "Attach images or documents" : "Attach images"}
        >
          <IconPaperclip size={18} />
        </ActionIcon>
      )}
    </FileButton>
  );
}
