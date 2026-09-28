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
export const CAPABILITY_KINDS = ["plugins", "skills", "tools"] as const;

export interface CapabilityUsageChange {
  kind: keyof CapabilityVisibility;
  name: string;
  enabled: boolean;
}

/** A replacement can enable each old exclusion and disable each new exclusion in all three lists. */
export const MAX_CAPABILITY_USAGE_CHANGES = MAX_HIDDEN_CAPABILITIES * CAPABILITY_KINDS.length * 2;

export function isCapabilityUsageChanges(value: unknown): value is CapabilityUsageChange[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITY_USAGE_CHANGES) return false;
  const seen = new Map<string, Set<string>>();
  return value.every(change => {
    if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).length !== 3) return false;
    const { kind, name, enabled } = change as Record<string, unknown>;
    if (typeof kind !== "string" || !CAPABILITY_KINDS.some(key => key === kind) || typeof name !== "string" || typeof enabled !== "boolean") return false;
    if (!(kind === "plugins" ? isPluginName(name) : isSlug(name))) return false;
    const names = seen.get(kind) ?? new Set<string>();
    if (names.has(name)) return false;
    names.add(name); seen.set(kind, names);
    return true;
  });
}

/** Send only explicit edits, so saving one page cannot restore another administrator's exclusions. */
export function capabilityUsageChanges(before: CapabilityVisibility, after: CapabilityVisibility): CapabilityUsageChange[] {
  return CAPABILITY_KINDS.flatMap(kind => {
    const previous = new Set(before[kind]);
    const next = new Set(after[kind]);
    return [...new Set([...previous, ...next])].filter(name => previous.has(name) !== next.has(name))
      .map(name => ({ kind, name, enabled: !next.has(name) }));
  });
}

export function emptyCapabilityVisibility(): CapabilityVisibility {
  return { plugins: [], skills: [], tools: [] };
}

export function isCapabilityVisibility(value: unknown): value is CapabilityVisibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3) return false;
  return CAPABILITY_KINDS.every(kind => {
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
