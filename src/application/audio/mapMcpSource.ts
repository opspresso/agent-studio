import { createHash } from "node:crypto";
import type { McpSourceMapping } from "@/domain/mcp/sourceMapping";
import type { SourceRefresh } from "@/domain/artifact/sourceReference";
import type { McpToolResult } from "@/domain/llm/types";

export type RegisterMcpSource = (input: { projectName: string; userEmail: string; namespace: string;
  itemId: string; url: string; filename: string; mimeType: string; refresh?: SourceRefresh }) => Promise<{ sourceRef: string; filename: string; mimeType: string }>;

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part) ||
      part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function readMcpSourceResult(raw: unknown, mapping: McpSourceMapping, serverName: string) {
  const result = raw as { structuredContent?: unknown; content?: unknown[]; isError?: boolean; resultType?: string } | undefined;
  if (!result || result.isError || result.resultType === "input_required") throw new Error("Source call failed");
  const text = (result.content ?? []).flatMap((item) => {
    const block = item as { type?: unknown; text?: unknown } | null;
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
  const body: unknown = result.structuredContent ?? JSON.parse(text);
  const url = readPath(body, mapping.urlPath);
  const rawId = readPath(body, mapping.idPath);
  const itemId = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
  const filename = mapping.namePath ? readPath(body, mapping.namePath) : "source";
  if (typeof url !== "string" || !url || url.length > 8192 || typeof itemId !== "string" || !itemId || itemId.length > 512 ||
    typeof filename !== "string" || !filename.trim() || filename.length > 255 || itemId.includes(url) || filename.includes(url)) {
    throw new Error("Invalid source mapping result");
  }
  const namespace = createHash("sha256").update(JSON.stringify([serverName, mapping.namespace])).digest("hex");
  return { url, itemId, filename, namespace, mimeType: mapping.mimeType };
}

/** Never return the raw response on a mapping failure: it may contain live access URLs. */
export async function mapMcpSource(input: {
  result: unknown; mapping: McpSourceMapping; serverName: string; projectName: string;
  userEmail?: string; register?: RegisterMcpSource; refresh?: SourceRefresh;
}): Promise<McpToolResult> {
  if (!input.userEmail || !input.register) return { text: "Error: private source references are unavailable for this run." };
  try {
    if (input.mapping.refreshArgument && !input.refresh) throw new Error("Source refresh identity unavailable");
    const source = readMcpSourceResult(input.result, input.mapping, input.serverName);
    const reference = await input.register({ projectName: input.projectName, userEmail: input.userEmail,
      ...source, ...(input.refresh ? { refresh: input.refresh } : {}) });
    return { text: JSON.stringify({ source_ref: reference.sourceRef, filename: reference.filename,
      mime_type: reference.mimeType, source: input.serverName, external_id: source.itemId }) };
  } catch {
    return { text: "Error: the MCP file response could not be registered as a private source." };
  }
}
