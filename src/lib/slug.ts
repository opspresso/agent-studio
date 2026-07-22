// Normalizes user input to the slug format required by name fields
// (lowercase letters, digits, hyphens — matches /^[a-z0-9-]+$/ in API schemas).
export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
