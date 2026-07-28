"use client";

import { Code, Group } from "@mantine/core";
import { CopyButton } from "./CopyButton";

/** Shared URL display row: truncated monospace URL plus a copy button. */
export function CopyableUrl({ url }: { url: string }) {
  return (
    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
      <Code
        title={url}
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {url}
      </Code>
      <CopyButton text={url} />
    </Group>
  );
}
