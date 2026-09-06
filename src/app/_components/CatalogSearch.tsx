import { ActionIcon, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";

/** Shared catalog search; each page owns the fields and filters being searched. */
export function CatalogSearch({
  value,
  onChange,
  placeholder,
  resultCount,
  totalCount,
  onReset,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  resultCount?: number;
  totalCount?: number;
  onReset?: () => void;
}) {
  const t = useT();
  return (
    <Stack gap={6} w={{ base: "100%", sm: 360 }} maw="100%">
      <TextInput
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        leftSection={<IconSearch size={16} />}
        rightSection={value ? (
          <ActionIcon
            variant="subtle"
            color="gray"
            onClick={() => onChange("")}
            aria-label={t("catalog.clearSearch")}
          >
            <IconX size={14} />
          </ActionIcon>
        ) : undefined}
      />
      <Group justify="space-between" gap="xs">
        {resultCount !== undefined && totalCount !== undefined && (
          <Text size="xs" c="dimmed" role="status" aria-live="polite">
            {t("catalog.resultCount", { count: resultCount, total: totalCount })}
          </Text>
        )}
        {onReset && (
          <Button variant="subtle" size="compact-xs" onClick={onReset}>
            {t("catalog.resetFilters")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

/** Case-insensitive match over the fields a card actually shows. */
export function matchesFilter(filter: string, ...fields: Array<string | undefined>): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return fields.some((field) => field?.toLowerCase().includes(needle));
}
