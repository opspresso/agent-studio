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
    // Own keys only: `{{constructor}}` is \w+ like any other placeholder, and a
    // plain lookup answers it with `Object.prototype.constructor` — a function
    // whose source would be rendered into the prompt where "" belongs.
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    return value === undefined || value === null ? "" : String(value);
  });
}
