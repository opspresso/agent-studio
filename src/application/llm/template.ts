/**
 * Prompt template rendering: `{{var}}` placeholders are replaced with the
 * matching variable value, and missing variables collapse to an empty string.
 */

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

export function findTemplateVariables(template: string): Set<string> {
  const names = new Set<string>();
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

export function renderTemplate(
  template: string,
  variables: Record<string, string> = {},
): string {
  if (!template) {
    return "";
  }
  return template.replace(VARIABLE_PATTERN, (_full, name: string) => {
    const value = variables[name];
    return value === undefined || value === null ? "" : String(value);
  });
}
