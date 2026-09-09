"use client";

import { Button, Group, Paper, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { MAX_MCP_SOURCE_MAPPINGS, type McpSourceMapping } from "@/domain/mcp/sourceMapping";

export function SourceMappings({ value, onChange }: { value: McpSourceMapping[]; onChange(value: McpSourceMapping[]): void }) {
  const t = useT();
  const update = (index: number, patch: Partial<McpSourceMapping>) => onChange(value.map((item, i) => i === index ? { ...item, ...patch } : item));
  return <Stack gap="sm">
    <Text size="sm" c="dimmed">{t("audio.mappingHint")}</Text>
    {value.map((item, index) => <Paper key={index} withBorder p="sm">
      <Stack gap="xs">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t("audio.mappingTool")} value={item.tool} required onChange={(e) => update(index, { tool: e.currentTarget.value })} />
          <TextInput label={t("audio.namespace")} value={item.namespace} required onChange={(e) => update(index, { namespace: e.currentTarget.value })} />
          <TextInput label={t("audio.urlPath")} value={item.urlPath.join(".")} required onChange={(e) => update(index, { urlPath: e.currentTarget.value.split(".") })} />
          <TextInput label={t("audio.idPath")} value={item.idPath.join(".")} required onChange={(e) => update(index, { idPath: e.currentTarget.value.split(".") })} />
          <TextInput label={t("audio.namePath")} value={item.namePath?.join(".") ?? ""} onChange={(e) => update(index, { namePath: e.currentTarget.value ? e.currentTarget.value.split(".") : undefined })} />
          <TextInput label={t("audio.mimeType")} value={item.mimeType} required onChange={(e) => update(index, { mimeType: e.currentTarget.value })} />
        </SimpleGrid>
        <Group justify="flex-end"><Button size="xs" variant="subtle" color="red" onClick={() => onChange(value.filter((_, i) => i !== index))}>{t("audio.removeMapping")}</Button></Group>
      </Stack>
    </Paper>)}
    <Button variant="light" size="xs" disabled={value.length >= MAX_MCP_SOURCE_MAPPINGS} onClick={() => onChange([...value, { tool: "", namespace: "", urlPath: [""], idPath: [""], mimeType: "audio/mpeg" }])}>{t("audio.addMapping")}</Button>
  </Stack>;
}
