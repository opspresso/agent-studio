/** A version-owned projection of one MCP JSON response into a private file reference. */
export interface McpSourceMapping {
  tool: string;
  namespace: string;
  urlPath: string[];
  idPath: string[];
  namePath?: string[];
  mimeType: string;
}

export function isMcpSourceMapping(value: unknown): value is McpSourceMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const name = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
  const path = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 8 &&
    value.every((part) => name(part) && !["__proto__", "prototype", "constructor"].includes(part));
  return name(item.tool) && name(item.namespace) && path(item.urlPath) && path(item.idPath) &&
    (item.namePath === undefined || path(item.namePath)) && typeof item.mimeType === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(item.mimeType);
}
