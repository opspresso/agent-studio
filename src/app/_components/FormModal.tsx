"use client";

import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

/**
 * The form-modal shell: one owner of how a modal form looks and closes.
 * `closeOnClickOutside={false}` is the point — a form that vanished because
 * the pointer drifted over the edge would lose whatever was typed. The error
 * renders beside the buttons, where the press that failed just happened, so a
 * long form does not have to be scrolled to learn why nothing happened.
 *
 * `McpBindingSettings` is deliberately not a caller: it has no form — its
 * footer button runs the page's own version save — and its footer slot
 * rotates between hint, error, and saved state.
 */
export function FormModal({
  opened,
  onClose,
  title,
  error,
  onSubmit,
  submitLabel,
  submitting,
  submitDisabled,
  hint,
  children,
}: {
  opened: boolean;
  onClose: () => void;
  title: string;
  error: string | null;
  /** Called on submit; the shell has already prevented the default. */
  onSubmit: () => void;
  submitLabel: string;
  submitting: boolean;
  submitDisabled?: boolean;
  /** Footer-left note: what pressing submit will actually do. */
  hint?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg" closeOnClickOutside={false}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Stack gap="md">
          {children}

          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}

          <Group
            justify="flex-end"
            gap="sm"
            pt="sm"
            style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
          >
            {hint && (
              <Text fz="xs" c="dimmed" mr="auto">
                {hint}
              </Text>
            )}
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={submitting} disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
