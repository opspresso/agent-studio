import { MAX_DOCUMENT_EDITS, MAX_DOCUMENT_ASSETS, MAX_DOCUMENT_ASSET_BYTES, MAX_DOCUMENT_TOOL_CHARS } from "@/domain/document/processor";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import type { McpToolResult } from "@/domain/llm/types";
import type { RunOrigin } from "@/domain/execution/actor";
import { artifactOwnerEmail, baseMimeType, MAX_SAVED_FILE_BYTES, savedFileName } from "@/domain/artifact/types";
import { MAX_DOCUMENT_BYTES, documentKind } from "@/domain/llm/documentLimits";
import { DOCUMENT_FORMATS, DOCUMENT_PROFILES, DOCUMENT_THEMES, DOCUMENT_LAYOUTS, DocumentProcessingError, type DocumentEdit, type DocumentAsset, type DocumentColors, type EffectiveDocumentStyle } from "@/domain/document/processor";
import { createArtifactId } from "@/application/artifact/storeArtifact";
import { FILE_DELIVERY_INSTRUCTION } from "@/application/artifact/fileDelivery";
import { ELIDED_FILE_CONTENT_ERROR, isElidedToolArgument } from "@/application/llm/toolArgumentElision";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import type { DocumentRenderer, DocumentEditor } from "@/domain/document/processor";

export interface FileToolDeps {
  readPrivateArtifact?: (id: string, email: string, maxBytes: number) => Promise<{ bytes: Uint8Array }>;
  artifacts?: ArtifactStorage;
  documents: DocumentExtractor;
  documentRenderer?: DocumentRenderer;
  documentEditor?: DocumentEditor;
  now?: () => Date;
}
import { framedDocument } from "@/application/llm/documentParts";
import { cutCodePoints, decodeUtf8Text } from "@/shared/utf8Text";
import { log } from "@/shared/logger";


function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DocumentProcessingError(`${name} is required`);
  return value;
}

function assertFileContent(value: unknown): void {
  if (isElidedToolArgument(value)) throw new DocumentProcessingError(ELIDED_FILE_CONTENT_ERROR);
}

/** File identities are resolved by trusted storage, never by a model-provided object key or URL. */
export function buildFileTool(
  deps: FileToolDeps,
  agentName: string,
  origin: RunOrigin,
  signal?: AbortSignal,
): ((args: Record<string, unknown>) => Promise<McpToolResult>) | undefined {
  const storage = deps.artifacts;
  const renderer = deps.documentRenderer;
  const editor = deps.documentEditor;
  if (!storage || !renderer || !editor) return undefined;
  const issued = new Set<string>();

  async function source(value: unknown, allowPrivate = false) {
    const id = requiredString(value, "file_id");
    if (id.length > 128) throw new DocumentProcessingError("File unavailable");
    const artifact = await storage!.rows.get(id);
    const actor = origin.actor;
    const own = artifact && artifactOwnerEmail(artifact.actor, artifact.ownerEmail) === origin.user.email &&
      (actor.kind === "user" || artifact.agentName === (origin.ancestry[0] ?? agentName));
    if (!artifact || (!own && !issued.has(id))) throw new DocumentProcessingError("File unavailable");
    if (artifact.byteSize > MAX_DOCUMENT_BYTES) throw new DocumentProcessingError("This file exceeds the document input byte limit");
    if (artifact.privateFileId && (!allowPrivate || actor?.kind !== "user" || !deps.readPrivateArtifact)) {
      throw new DocumentProcessingError("Private artifacts support authenticated read and inspect only");
    }
    const read = artifact.privateFileId
      ? await deps.readPrivateArtifact!(artifact.artifactId, actor!.id, MAX_DOCUMENT_BYTES)
      : await storage!.objects.read(artifact.key, MAX_DOCUMENT_BYTES);
    return { artifact, file: { bytes: read.bytes, mimeType: artifact.mimeType, name: artifact.filename ?? "file" } };
  }

  function output(bytes: Uint8Array, mimeType: string, name: string, warnings: string[], derivedFrom?: string, style?: EffectiveDocumentStyle): McpToolResult {
    const artifactId = createArtifactId();
    issued.add(artifactId);
    const filename = savedFileName(name, mimeType);
    return {
      text: `Created ${JSON.stringify(filename)} (file ID: ${artifactId}).` +
        `\n${FILE_DELIVERY_INSTRUCTION}` +
        (style ? `\nDesign: theme=${style.theme}; profile=${style.profile ?? "spreadsheet"}; layout=${style.layout ?? "grid"}; font=${style.fontFamily}.` : "") +
        `${warnings.length ? `\n${warnings.join("\n")}` : ""}`,
      files: [{ b64: Buffer.from(bytes).toString("base64"), mimeType, name: filename, artifactId, ...(derivedFrom ? { derivedFrom } : {}) }],
    };
  }

  return async (args) => {
    try {
      signal?.throwIfAborted();
      if (args.operation !== "create" && ["profile", "theme", "colors", "layout"].some(name => args[name] !== undefined)) {
        throw new DocumentProcessingError("Design options apply only to newly created files; existing-file edits preserve their original style");
      }
      if (args.operation === "create") {
        assertFileContent(args.content);
        const format = DOCUMENT_FORMATS.find((format) => format === args.format);
        if (!format) throw new DocumentProcessingError(`format must be one of ${DOCUMENT_FORMATS.join(", ")}`);
        const profile = args.profile === undefined ? undefined : DOCUMENT_PROFILES.find((profile) => profile === args.profile);
        if (args.profile !== undefined && !profile) throw new DocumentProcessingError("Unknown document profile");
        const theme = args.theme === undefined ? undefined : DOCUMENT_THEMES.find(theme => theme === args.theme);
        if (args.theme !== undefined && !theme) throw new DocumentProcessingError("Unknown document theme");
        const layout = args.layout === undefined ? undefined : DOCUMENT_LAYOUTS.find(layout => layout === args.layout);
        if (args.layout !== undefined && !layout) throw new DocumentProcessingError("Unknown document layout");
        if (args.colors !== undefined && (!args.colors || typeof args.colors !== "object" || Array.isArray(args.colors))) {
          throw new DocumentProcessingError("colors must map supported roles to six-digit hex values");
        }
        const title = typeof args.title === "string" && args.title.trim() ? args.title : "Document";
        const assets: Record<string, DocumentAsset> = {};
        if (args.assets !== undefined) {
          if (!args.assets || typeof args.assets !== "object" || Array.isArray(args.assets)) throw new DocumentProcessingError("assets must map names to file IDs");
          const entries = Object.entries(args.assets);
          if (entries.length > MAX_DOCUMENT_ASSETS) throw new DocumentProcessingError(`At most ${MAX_DOCUMENT_ASSETS} document image assets are supported`);
          let assetBytes = 0;
          for (const [name, id] of entries) {
            const { file } = await source(id);
            if (file.mimeType !== "image/png" && file.mimeType !== "image/jpeg") throw new DocumentProcessingError("Document assets must be PNG or JPEG");
            assetBytes += file.bytes.byteLength;
            if (assetBytes > MAX_DOCUMENT_ASSET_BYTES) throw new DocumentProcessingError("Image assets exceed the document byte budget");
            Object.defineProperty(assets, name, { value: { bytes: file.bytes, mimeType: file.mimeType }, enumerable: true });
          }
        }
        const created = await renderer.create({
          format, title, created: (deps.now?.() ?? new Date()).toISOString(),
          ...(args.content !== undefined ? { content: requiredString(args.content, "content") } : {}),
          ...(args.sheets !== undefined ? { sheets: args.sheets } : {}),
          ...(profile ? { profile } : {}),
          ...(theme ? { theme } : {}), ...(layout ? { layout } : {}),
          ...(args.colors !== undefined ? { colors: args.colors as Partial<DocumentColors> } : {}),
          ...(Object.keys(assets).length ? { assets } : {}),
        }, signal);
        return output(created.bytes, created.mimeType, typeof args.name === "string" ? args.name : title, created.validation.warnings, undefined, created.style);
      }
      const { artifact, file } = await source(args.file_id, args.operation === "read" || args.operation === "inspect");
      const svg = baseMimeType(file.mimeType) === "image/svg+xml";
      if (args.operation === "read") {
        if (svg) {
          const text = decodeUtf8Text(file.bytes);
          if (text === null) throw new DocumentProcessingError("This SVG is not UTF-8 text");
          assertFileContent(text);
          return { text: framedDocument(file.name, cutCodePoints(text, MAX_DOCUMENT_TOOL_CHARS), text.length > MAX_DOCUMENT_TOOL_CHARS ? "partial SVG markup" : "SVG markup", artifact.artifactId) };
        }
        const extracted = await deps.documents.extract({ ...file, maxChars: MAX_DOCUMENT_TOOL_CHARS, signal });
        assertFileContent(extracted.text);
        return { text: framedDocument(file.name, extracted.text, extracted.note, artifact.artifactId) };
      }
      if (args.operation === "inspect") {
        const from = args.from === undefined ? 0 : Number(args.from);
        if (!Number.isInteger(from) || from < 0) throw new DocumentProcessingError("from must be a non-negative integer");
        if (args.mode !== undefined && args.mode !== "structure" && args.mode !== "edit_targets") throw new DocumentProcessingError("Unknown inspection mode");
        if (args.include_hidden !== undefined && typeof args.include_hidden !== "boolean") throw new DocumentProcessingError("include_hidden must be boolean");
        const kind = documentKind(file.mimeType, file.name);
        if (kind === "text" || kind === "html" || svg) {
          const text = decodeUtf8Text(file.bytes);
          if (text === null) throw new DocumentProcessingError("This file is not UTF-8 text");
          assertFileContent(text);
          return { text: framedDocument(file.name, cutCodePoints(text, MAX_DOCUMENT_TOOL_CHARS), `${text.length > MAX_DOCUMENT_TOOL_CHARS ? "Partial text; " : ""}text editing uses part=text and index=0 with an original substring that occurs once`, artifact.artifactId) };
        }
        const inspected = await editor.inspect(file, { from, mode: args.mode, includeHidden: args.include_hidden }, signal);
        return { text: framedDocument(file.name, inspected.text, [inspected.complete ? "complete inspection" : "partial inspection", ...inspected.warnings].join("; "), artifact.artifactId) };
      }
      if (args.operation === "edit") {
        if (!Array.isArray(args.edits) || args.edits.length === 0 || args.edits.length > MAX_DOCUMENT_EDITS || args.edits.some((edit) => !edit || typeof edit !== "object")) {
          throw new DocumentProcessingError(`edits must contain 1–${MAX_DOCUMENT_EDITS} explicit edit operations`);
        }
        const edits = args.edits as DocumentEdit[];
        for (const edit of edits) {
          if (edit.operation === "replace_text") assertFileContent(edit.replacement);
          if (edit.operation === "set_cell") assertFileContent(edit.value);
        }
        if (documentKind(file.mimeType, file.name) === "text" || documentKind(file.mimeType, file.name) === "html" || svg) {
          if (file.bytes.byteLength > MAX_SAVED_FILE_BYTES) throw new DocumentProcessingError("This text file exceeds the editing byte limit");
          let text = decodeUtf8Text(file.bytes);
          if (text === null) throw new DocumentProcessingError("This file is not UTF-8 text");
          let textBytes = Buffer.byteLength(text, "utf8");
          for (const edit of edits) {
            if (edit.operation !== "replace_text" || edit.part !== "text" || edit.index !== 0 || typeof edit.text !== "string" || !edit.text || typeof edit.replacement !== "string") {
              throw new DocumentProcessingError("Text files use replace_text with part=text, index=0, unique original text and replacement");
            }
            const replacementBytes = Buffer.byteLength(edit.replacement, "utf8");
            if (replacementBytes > MAX_SAVED_FILE_BYTES) throw new DocumentProcessingError("Replacement exceeds the editing byte limit");
            const start = text.indexOf(edit.text);
            if (start < 0 || text.indexOf(edit.text, start + 1) >= 0) throw new DocumentProcessingError("Original text must match exactly once");
            textBytes += replacementBytes - Buffer.byteLength(edit.text, "utf8");
            if (textBytes > MAX_SAVED_FILE_BYTES) throw new DocumentProcessingError("The edited text exceeds the editing byte limit");
            text = text.slice(0, start) + edit.replacement + text.slice(start + edit.text.length);
          }
          if (!text.isWellFormed()) throw new DocumentProcessingError("Replacement contains invalid Unicode");
          if (baseMimeType(file.mimeType) === "application/json" || baseMimeType(file.mimeType).endsWith("+json") || /\.json$/i.test(file.name)) {
            try { JSON.parse(text); } catch { throw new DocumentProcessingError("The edited JSON is invalid"); }
          }
          const bytes = Buffer.from(text, "utf8");
          if (bytes.length > MAX_SAVED_FILE_BYTES) throw new DocumentProcessingError("The edited text exceeds the saved file byte limit");
          return output(bytes, file.mimeType, typeof args.name === "string" ? args.name : file.name, [], artifact.artifactId);
        }
        const edited = await editor.edit(file, edits, signal);
        return output(edited.bytes, edited.mimeType, typeof args.name === "string" ? args.name : file.name, edited.validation.warnings, artifact.artifactId);
      }
      throw new DocumentProcessingError("operation must be read, inspect, create or edit");
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DocumentProcessingError || error instanceof DocumentExtractionError) return { text: `Error: ${error.message}` };
      log.error("artifact", "file operation failed", error);
      return { text: "Error: the file operation could not be completed" };
    }
  };
}
