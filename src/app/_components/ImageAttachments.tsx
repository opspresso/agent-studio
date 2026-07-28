"use client";

import { useCallback, useRef, useState } from "react";
import { ActionIcon, Box, FileButton, Group, Image, Stack, Text } from "@mantine/core";
import { IconPaperclip, IconX } from "@tabler/icons-react";
import {
  ACCEPTED_IMAGE_TYPES,
  attachmentSrc,
  readAttachment,
  type Attachment,
} from "../_lib/imageAttachments";
import { MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";

/**
 * Staged image attachments for one turn — shared by the chat composers and the
 * project run panel so every surface enforces one set of limits and reports
 * rejections the same way.
 */
export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setAttachError(null);
    const added: Attachment[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        added.push(await readAttachment(file));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `${file.name}: unreadable`);
      }
    }
    // Reported from here, not from inside the updater: the updater runs after the
    // check below, so a message pushed there would never be shown — the images
    // over the cap would just disappear.
    if (added.length > Math.max(MAX_ATTACHMENTS - attachments.length, 0)) {
      failures.push(`At most ${MAX_ATTACHMENTS} images per message`);
    }
    setAttachments((prev) => [
      ...prev,
      ...added.slice(0, Math.max(MAX_ATTACHMENTS - prev.length, 0)),
    ]);
    if (failures.length > 0) {
      setAttachError(failures.join(" · "));
    }
  }, [attachments.length]);

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
    <Stack gap={4} mb="xs">
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
}: {
  onPick: (files: File[]) => void;
  disabled?: boolean;
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
      accept={ACCEPTED_IMAGE_TYPES.join(",")}
      multiple
    >
      {(props) => (
        <ActionIcon
          {...props}
          variant="default"
          size="input-sm"
          disabled={disabled}
          aria-label="Attach images"
          title="Attach images"
        >
          <IconPaperclip size={18} />
        </ActionIcon>
      )}
    </FileButton>
  );
}
