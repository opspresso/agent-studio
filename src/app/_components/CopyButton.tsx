"use client";

import { Button, CopyButton as MantineCopyButton } from "@mantine/core";

/**
 * Clipboard button with transient "Copied" feedback.
 *
 * A wrapper over Mantine's `CopyButton`, which is a render prop: six call sites
 * would otherwise each spell out the same `{({ copied, copy }) => …}` block,
 * and the label is the only thing any of them varies.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <MantineCopyButton value={text} timeout={1500}>
      {({ copied, copy }) => (
        <Button variant="default" size="compact-xs" onClick={copy} style={{ flexShrink: 0 }}>
          {copied ? "Copied" : label}
        </Button>
      )}
    </MantineCopyButton>
  );
}
