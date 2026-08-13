"use client";

import { Button, CopyButton as MantineCopyButton } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

/**
 * Clipboard button with transient "Copied" feedback.
 *
 * A wrapper over Mantine's `CopyButton`, which is a render prop: six call sites
 * would otherwise each spell out the same `{({ copied, copy }) => …}` block,
 * and the label is the only thing any of them varies.
 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  return (
    <MantineCopyButton value={text} timeout={1500}>
      {({ copied, copy }) => (
        <Button variant="default" size="compact-xs" onClick={copy} style={{ flexShrink: 0 }}>
          {copied ? t("common.copied") : (label ?? t("common.copy"))}
        </Button>
      )}
    </MantineCopyButton>
  );
}
