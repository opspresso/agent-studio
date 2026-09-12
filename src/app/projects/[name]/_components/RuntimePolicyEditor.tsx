"use client";

import { NumberInput, Stack, TagsInput, Text } from "@mantine/core";
import type { RuntimePolicy } from "@/domain/execution/runtimeSession";
import { useT } from "@/app/_i18n/provider";

export function RuntimePolicyEditor({ value, onChange }: { value: RuntimePolicy | undefined; onChange: (policy: RuntimePolicy) => void }) {
  const t = useT();
  const policy = value ?? {};
  return <Stack gap="xs">
    <Text fw={600} size="sm">{t("version.runtimePolicy")}</Text>
    <NumberInput label={t("version.maxInputChars")} min={1} max={1_000_000} allowDecimal={false}
      value={policy.maxInputChars ?? ""} onChange={(next) => onChange({ ...policy, maxInputChars: typeof next === "number" ? next : undefined })} />
    <TagsInput label={t("version.blockedTools")} value={policy.blockedTools ?? []}
      onChange={(blockedTools) => onChange({ ...policy, blockedTools })} />
    <TagsInput label={t("version.approvalTools")} description={t("version.approvalToolsHint")} value={policy.approvalTools ?? []}
      onChange={(approvalTools) => onChange({ ...policy, approvalTools })} />
  </Stack>;
}
