import { createArtifactId } from "@/application/artifact/storeArtifact";
/** The SaveFile builtin: text a run wrote, kept as a file the reader receives. */

import type * as engine from "@/application/llm/engine";
import type { McpToolResult } from "@/domain/llm/types";
import {
  baseMimeType,
  isSavable,
  MAX_SAVED_FILE_BYTES,
  SAVABLE_TYPES,
  savedFileName,
} from "@/domain/artifact/types";
import type { ExecutionDeps } from "./deps";

/** Whole kilobytes, so a refusal names a size in the units the limit is stated in. */
function kb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * Turn one call into bytes the run will store, or into the reason it will not.
 *
 * A refusal is a tool result rather than a thrown error, and that is the whole
 * shape of this: the model asked for something reasonable in a way this platform
 * does not take, and it can fix the call itself if it is told which part was
 * wrong. Throwing would end the run over a filename.
 */
export function saveFileResult(input: {
  name: unknown;
  mimeType: unknown;
  content: unknown;
}): McpToolResult {
  // The bare type, not what was asked for: a model may name a charset, and a
  // parameter riding along would reach the row, where `artifactObjectKey`
  // matches exactly and stores the file as `.bin`.
  const mimeType = typeof input.mimeType === "string" ? baseMimeType(input.mimeType) : "";
  const content = typeof input.content === "string" ? input.content : "";
  const name = typeof input.name === "string" ? input.name : "";

  if (!isSavable(mimeType)) {
    return {
      text:
        `Error: SaveFile does not write ${mimeType || "that type"}. ` +
        `It writes ${SAVABLE_TYPES.join(", ")}. An image comes from GenerateImage, ` +
        `and a DOCX, PPTX, PDF or HWPX from a document tool if this run has one.`,
    };
  }
  if (content === "") {
    return { text: "Error: SaveFile needs the file's content as text." };
  }
  const bytes = Buffer.from(content, "utf-8");
  if (bytes.byteLength > MAX_SAVED_FILE_BYTES) {
    return {
      text:
        `Error: that file is ${kb(bytes.byteLength)}, over the ${kb(MAX_SAVED_FILE_BYTES)} limit. ` +
        `Write less, or split what you are saving across files.`,
    };
  }

  const filename = savedFileName(name, mimeType);
  return {
    // What the model is told, and all it needs: the file exists and the reader
    // has it. The address is the surface's business — it is minted per reader,
    // and a model that had one would only be able to repeat it into the answer,
    // where it would outlive the turn and belong to whoever read the transcript.
    text: `Saved ${filename} (${kb(bytes.byteLength)}). The reader has it; do not repeat its contents in your answer.`,
    files: [{ b64: bytes.toString("base64"), mimeType, name: filename }],
  };
}

/**
 * The SaveFile builtin, or nothing when this deployment keeps nothing.
 *
 * Gated on storage rather than on the version, unlike the image builtins and
 * FetchUrl. Those two are decisions — one spends money per call, the other
 * sends a request to wherever the model says. Writing a file the person asked
 * for is neither: it costs a PUT, reaches nothing outside this deployment, and
 * a run that cannot do it has to paste a report into the chat window instead.
 *
 * What it is gated on is the only thing that can make it fail silently. Without
 * `artifacts` the bracket stores nothing, and the file would be announced,
 * stripped of its bytes, and reach the reader as a row with no download.
 */
export function buildFileSaver(
  deps: Pick<ExecutionDeps, "artifacts">,
): engine.AgentCapabilityDeps["saveFile"] {
  if (!deps.artifacts) {
    return undefined;
  }
  return async (input) => {
    const result = saveFileResult(input);
    if (!result.files?.length) return result;
    const files = result.files.map((file) => ({ ...file, artifactId: createArtifactId() }));
    return { ...result, files, text: `${result.text} File ID: ${files[0]!.artifactId}.` };
  };
}
