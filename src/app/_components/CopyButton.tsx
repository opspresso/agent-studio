"use client";

import { Button, CopyButton as MantineCopyButton, type ButtonProps } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

/**
 * Clipboard button with transient "Copied" feedback.
 *
 * A wrapper over Mantine's `CopyButton`, which is a render prop: six call sites
 * would otherwise each spell out the same `{({ copied, copy }) => …}` block,
 * and the label is the only thing any of them varies.
 */
export function CopyButton({ text, label, size = "compact-xs", disabled }: { text: string; label?: string; size?: ButtonProps["size"]; disabled?: boolean }) {
  const t = useT();
  return (
    <MantineCopyButton value={text} timeout={1500}>
      {({ copied, copy }) => (
        <Button variant="default" size={size} disabled={disabled} onClick={copy} style={{ flexShrink: 0 }}>
          {copied ? t("common.copied") : (label ?? t("common.copy"))}
        </Button>
      )}
    </MantineCopyButton>
  );
}
