import { createHash } from "node:crypto";
import type { McpSourceMapping } from "@/domain/mcp/sourceMapping";
import type { McpToolResult } from "@/domain/llm/types";

export type RegisterMcpSource = (input: { projectName: string; userEmail: string; namespace: string;
  itemId: string; url: string; filename: string; mimeType: string }) => Promise<{ sourceRef: string; filename: string; mimeType: string }>;

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part) ||
      part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Never return the raw response on a mapping failure: it may contain live access URLs. */
export async function mapMcpSource(input: {
  result: unknown; mapping: McpSourceMapping; serverName: string; projectName: string;
  userEmail?: string; register?: RegisterMcpSource;
}): Promise<McpToolResult> {
  if (!input.userEmail || !input.register) return { text: "Error: private source references are unavailable for this run." };
  try {
    const result = input.result as { structuredContent?: unknown; content?: unknown[]; isError?: boolean; resultType?: string } | undefined;
    if (!result || result.isError || result.resultType === "input_required") throw new Error("Source call failed");
    const text = (result.content ?? []).flatMap((item) => {
      const block = item as { type?: unknown; text?: unknown } | null;
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    }).join("\n");
    const body: unknown = result.structuredContent ?? JSON.parse(text);
    const url = readPath(body, input.mapping.urlPath);
    const rawId = readPath(body, input.mapping.idPath);
    const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
    const filename = input.mapping.namePath ? readPath(body, input.mapping.namePath) : "source";
    if (typeof url !== "string" || typeof id !== "string" || typeof filename !== "string") {
      return { text: "Error: the MCP file response did not match its configured source mapping." };
    }
    if (!url || id.includes(url) || filename.includes(url)) throw new Error("Invalid identity mapping");
    const namespace = createHash("sha256").update(JSON.stringify([input.serverName, input.mapping.namespace])).digest("hex");
    const reference = await input.register({ projectName: input.projectName, userEmail: input.userEmail,
      namespace, itemId: id, url, filename, mimeType: input.mapping.mimeType });
    // This is an explicit file projection. Provider notes, alternate URLs and credentials
    // never travel into the model or trace alongside the opaque reference.
    return { text: JSON.stringify({ source_ref: reference.sourceRef, filename: reference.filename,
      mime_type: reference.mimeType, source: input.serverName, external_id: id }) };
  } catch {
    return { text: "Error: the MCP file response could not be registered as a private source." };
  }
}
