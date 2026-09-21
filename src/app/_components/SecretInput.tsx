"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Group, PasswordInput, Stack, Text, TextInput, type PasswordInputProps } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { compactSecretMask } from "@/app/_lib/secretMask";
import { monoInput } from "./monoInput";

interface SecretInputProps extends Omit<PasswordInputProps, "value" | "onChange" | "defaultValue" | "visible" | "onVisibilityChange"> {
  value: string;
  onChange(value: string): void;
  /** Masked value from the server, never inferred from a user's input. */
  storedValue?: string;
  /** An explicit reset is separate from clearing a replacement draft. */
  allowReset?: boolean;
}

/** External credentials share one editor; the eye reveals only the replacement being typed. */
export function SecretInput({ value, onChange, storedValue, allowReset = false, label, description, placeholder, disabled, style, className, styles = { innerInput: monoInput.input }, ...props }: SecretInputProps) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => { setVisible(false); setReplacing(false); }, [storedValue]);
  const configured = !!storedValue;
  const unchanged = configured && value === storedValue;
  const resetting = configured && allowReset && value === "";
  const draft = unchanged ? "" : value;
  const editing = !configured || replacing || !!draft;
  const fieldLabel = label && <Group component="span" gap="xs">{label}{configured && <Badge color="gray">{t("secrets.configured")}</Badge>}</Group>;
  return <Stack gap={6} style={style} className={className} miw={0}>
    {editing ? <PasswordInput {...props} label={fieldLabel}
      description={description} value={draft} disabled={disabled} styles={styles}
      autoComplete="new-password" visible={visible && !!draft} onVisibilityChange={setVisible}
      visibilityToggleFocusable
      visibilityToggleButtonProps={{ disabled: disabled || !draft, "aria-label": t(visible ? "secrets.hideInput" : "secrets.showInput") }}
      placeholder={resetting ? t("secrets.resetPending") : configured ? t("secrets.replacePlaceholder") : placeholder ?? t("secrets.inputPlaceholder")}
      onChange={event => {
        const next = event.currentTarget.value;
        if (!next) setVisible(false);
        onChange(next || storedValue || "");
      }} />
      : <TextInput label={fieldLabel} description={description} value={resetting ? "" : compactSecretMask(storedValue!)} readOnly disabled={disabled}
        aria-label={props["aria-label"]} placeholder={t("secrets.resetPending")} styles={monoInput} />}
    {configured && <Group gap="xs">
      <Button variant="default" size="compact-xs" disabled={disabled} onClick={() => {
        setVisible(false);
        setReplacing(!editing);
        onChange(storedValue);
      }}>{t(editing ? "common.cancel" : "secrets.replace")}</Button>
      {allowReset && <Button variant="subtle" size="compact-xs" disabled={disabled} onClick={() => {
        setVisible(false); setReplacing(false); onChange(resetting ? storedValue : "");
      }}>{t(resetting ? "common.cancel" : "secrets.resetOverride")}</Button>}
      {resetting && <Text size="xs" c="dimmed">{t("secrets.resetHint")}</Text>}
    </Group>}
  </Stack>;
}
