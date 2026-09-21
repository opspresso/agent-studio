"use client";

import { Card } from "@mantine/core";
import type { SettingFieldView, SettingsView } from "@/application/settings/settingsUseCases";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { SecretControl } from "@/app/_components/SecretControl";

export function SharedA2aKeySection({ field, onChanged, disabled }: {
  field: SettingFieldView;
  onChanged(view: SettingsView): void;
  disabled?: boolean;
}) {
  const t = useT();
  return <Card><SecretControl label={t("settings.field.a2aKey")} configured={!!field.value} masked={field.value}
    description={t("settings.hint.a2aKey")} disabled={disabled}
    onReveal={async () => (await readJson<{ key: string }>(await fetch("/api/settings/a2a-key/reveal", { method: "POST" }))).key}
    onGenerate={async () => {
      const result = await readJson<{ key: string; view: SettingsView }>(await fetch("/api/settings/a2a-key", { method: "POST" }));
      onChanged(result.view); return result.key;
    }}
    onReset={field.source === "override" ? async () => {
      onChanged(await readJson<SettingsView>(await fetch("/api/settings", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ a2aApiKey: "" }) })));
    } : undefined}
    onSave={async value => {
      const next = await readJson<SettingsView>(await fetch("/api/settings", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ a2aApiKey: value }) }));
      onChanged(next);
    }} />
  </Card>;
}
