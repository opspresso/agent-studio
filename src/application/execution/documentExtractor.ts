import {
  DocumentExtractionError,
  withOfficeDocumentReader,
  type DocumentExtractor,
} from "@/domain/llm/documentExtractor";
import type { RunOrigin } from "@/domain/execution/actor";
import type { Version } from "@/domain/project/types";
import { buildMcpTools, closeMcp, type McpToolDeps } from "./mcpTools";

const READ_DOCUMENT_TOOL = "read_document";
const CONTENT_SEPARATOR = "\n\n";

export interface OpenDocumentExtractorDeps extends McpToolDeps {
  documents: DocumentExtractor;
}

export interface OpenedDocumentExtractor {
  extractor: DocumentExtractor;
  close: () => Promise<void>;
}

function extractedText(result: string): string {
  if (result.startsWith("Error: ")) {
    throw new DocumentExtractionError(result.slice("Error: ".length));
  }
  const separator = result.indexOf(CONTENT_SEPARATOR);
  if (!result.startsWith("[Read from ") || separator < 0) {
    throw new DocumentExtractionError("the document MCP returned an unexpected read result");
  }
  return result.slice(separator + CONTENT_SEPARATOR.length);
}

/** Resolve read_document from this version's bound MCP capabilities. */
export async function openDocumentExtractor(
  deps: OpenDocumentExtractorDeps,
  version: Version,
  signal?: AbortSignal,
  origin?: Pick<RunOrigin, "actor" | "conversation">,
): Promise<OpenedDocumentExtractor> {
  const resolved = await buildMcpTools(deps, version, signal, origin);
  const candidate = resolved.mcpServers
    .map((server) => resolved.aliasFor?.(server.name, READ_DOCUMENT_TOOL))
    .find((alias): alias is string => alias !== undefined);
  const reader = candidate && resolved.callMcpTool
    ? async (input: { bytes: Uint8Array; name: string }) => {
        const result = await resolved.callMcpTool!(candidate, {
          content: Buffer.from(input.bytes).toString("base64"),
          filename: input.name,
        });
        return extractedText(result.text);
      }
    : undefined;
  return {
    extractor: withOfficeDocumentReader(
      deps.documents,
      reader,
      "no bound MCP server offers read_document, so this office document cannot be read",
    ),
    close: () => closeMcp(resolved.close),
  };
}
