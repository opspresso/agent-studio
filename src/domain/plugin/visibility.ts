import { isSlug } from "@/domain/naming";
import { isPluginName, parsePluginSource } from "./types";

/** Hidden registry names are deployment-owned and survive plugin syncs. Tools are MCP servers. */
export interface CapabilityVisibility {
  plugins: string[];
  skills: string[];
  tools: string[];
}

/** Bounds the name lists stored in the shared settings item. */
export const MAX_HIDDEN_CAPABILITIES = 500;

export function emptyCapabilityVisibility(): CapabilityVisibility {
  return { plugins: [], skills: [], tools: [] };
}

export function isCapabilityVisibility(value: unknown): value is CapabilityVisibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3) return false;
  return (["plugins", "skills", "tools"] as const).every(kind => {
    const names = record[kind];
    const validName = kind === "plugins" ? isPluginName : isSlug;
    return Array.isArray(names) && names.length <= MAX_HIDDEN_CAPABILITIES &&
      names.every(name => typeof name === "string" && validName(name));
  });
}

export function hiddenByPlugin(visibility: CapabilityVisibility, source?: string): string | undefined {
  const plugin = source ? parsePluginSource(source)?.plugin : undefined;
  return plugin && visibility.plugins.includes(plugin) ? plugin : undefined;
}

export function isCapabilityVisible(
  visibility: CapabilityVisibility,
  kind: keyof CapabilityVisibility,
  name: string,
  source?: string,
): boolean {
  return !visibility[kind].includes(name) && (kind === "plugins" || !hiddenByPlugin(visibility, source));
}
