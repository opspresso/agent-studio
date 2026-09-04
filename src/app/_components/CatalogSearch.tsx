import { TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";

/**
 * The one-line filter under a catalog header. One component so the four list
 * pages cannot drift on placement or feel; filtering itself stays with each
 * page, which knows which fields a match should read.
 */
export function CatalogSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <TextInput
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      leftSection={<IconSearch size={14} />}
      maw={360}
    />
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
