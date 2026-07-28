"use client";

import { Accordion, Group, Stack, Text } from "@mantine/core";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import type { HighlightLanguage } from "./highlight";

/**
 * A titled, collapsed-by-default code block. Expanding reveals the full
 * syntax-highlighted content (no height clamp; wide content scrolls
 * horizontally).
 */
export function CollapsibleCode({
  title,
  code,
  language,
  copyLabel = "Copy",
}: {
  title: string;
  code: string;
  language: HighlightLanguage;
  copyLabel?: string;
}) {
  return (
    <Accordion variant="contained" chevronPosition="left" radius="md">
      <Accordion.Item value="code">
        <Accordion.Control>
          <Text fz="xs" fw={500}>
            {title}
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="xs">
            <Group justify="flex-end">
              <CopyButton text={code} label={copyLabel} />
            </Group>
            <CodeBlock language={language} code={code} />
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
