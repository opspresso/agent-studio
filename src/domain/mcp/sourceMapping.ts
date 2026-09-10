export const MAX_MCP_SOURCE_MAPPINGS = 8;

/** A declarative projection of one MCP JSON response into a private file reference. */
export interface McpSourceMapping {
  tool: string;
  namespace: string;
  urlPath: string[];
  idPath: string[];
  namePath?: string[];
  mimeType: string;
  /** Opt-in replay of this read tool with the stable item ID in one fixed argument. */
  refreshArgument?: string;
}

export function isMcpSourceMapping(value: unknown): value is McpSourceMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["tool", "namespace", "urlPath", "idPath", "namePath", "mimeType", "refreshArgument"].includes(key))) return false;
  const name = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
  const path = (value: unknown) => Array.isArray(value) && value.length > 0 && value.length <= 8 &&
    value.every((part) => name(part) && !["__proto__", "prototype", "constructor"].includes(part));
  return name(item.tool) && name(item.namespace) && path(item.urlPath) && path(item.idPath) &&
    (item.refreshArgument === undefined || (name(item.refreshArgument) && !["__proto__", "prototype", "constructor"].includes(item.refreshArgument as string))) &&
    (item.namePath === undefined || path(item.namePath)) && typeof item.mimeType === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(item.mimeType);
}

/** Registry defaults and version overrides share the same bounded mapping contract. */
export function isMcpSourceMappings(value: unknown): value is McpSourceMapping[] {
  return Array.isArray(value) && value.length <= MAX_MCP_SOURCE_MAPPINGS && value.every(isMcpSourceMapping) &&
    new Set(value.map((item) => item.tool)).size === value.length;
}
