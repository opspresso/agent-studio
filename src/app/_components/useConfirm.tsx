"use client";

import { useCallback, useRef, useState } from "react";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";

type ConfirmOptions = {
  title: string;
  message: string;
  /** The action button's label — name the action ("Delete", "Publish"), never "OK". */
  confirmLabel: string;
  /** Require typing this exact text before the action enables (project deletion). */
  requireText?: string;
  /** Action button colour. Red (destructive) unless the ask is not one — publish passes teal. */
  color?: string;
};

/**
 * Modal replacement for `window.confirm`, and the single owner of how an
 * action is confirmed — destructive ones (the red default) and the one
 * deliberate non-destructive ask, publishing. Call `confirm(options)` and
 * await the boolean; render `confirmModal` anywhere in the component (the
 * Modal portals, so placement does not matter). Dismissing resolves `false`.
 */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setTyped("");
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      // A second ask while one is open replaces it; the first caller backs off.
      resolver.current?.(false);
      resolver.current = resolve;
    });
  }, []);

  function close(ok: boolean) {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
  }

  const blocked = options?.requireText !== undefined && typed !== options.requireText;

  const confirmModal = (
    <Modal
      opened={options !== null}
      onClose={() => close(false)}
      title={options?.title}
      centered
    >
      <Stack gap="md">
        <Text fz="sm">{options?.message}</Text>
        {options?.requireText !== undefined && (
          <TextInput
            label={`Type "${options.requireText}" to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !blocked) {
                close(true);
              }
            }}
            data-autofocus
            styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
          />
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button color={options?.color ?? "red"} disabled={blocked} onClick={() => close(true)}>
            {options?.confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );

  return { confirm, confirmModal };
}
