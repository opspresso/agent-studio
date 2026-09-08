import { AUDIO_JOB_TOOL_NAME, AUDIO_TOOL_NAMES, IMPORT_FILE_TOOL_NAME, TRANSCRIBE_AUDIO_TOOL_NAME } from "@/domain/llm/toolNames";
import type { RunActor } from "@/domain/execution/actor";
import type { McpToolResult } from "@/domain/llm/types";
import type { FileRetention } from "@/domain/artifact/retention";
import type { createSourceFileUseCases } from "@/application/artifact/sourceFiles";
import type { createAudioJobUseCases } from "./audioJobUseCases";
import { AppError, ValidationError } from "@/application/errors";
import { cutCodePoints } from "@/shared/utf8Text";
import { MAX_TRANSCRIPT_BYTES } from "./transcribeFile";

interface AudioToolDeps {
  jobs: ReturnType<typeof createAudioJobUseCases>;
  files: Pick<ReturnType<typeof createSourceFileUseCases>, "read">;
}

function text(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new ValidationError(`Invalid ${field}`);
  return value;
}

function retention(value: unknown): FileRetention {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Retention is required");
  const input = value as Record<string, unknown>;
  if ((input.unit !== "days" && input.unit !== "months") || typeof input.value !== "number" || typeof input.timezone !== "string") {
    throw new ValidationError("Invalid retention");
  }
  return { unit: input.unit, value: input.value, timezone: input.timezone };
}

function object(args: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`Invalid ${field}`);
  return value as Record<string, unknown>;
}

/** One bound user and occurrence, shared by all audio calls in an Agent run. */
export function createAudioTool(deps: AudioToolDeps, context: {
  projectName: string; userEmail: string; occurrence: string; actor?: RunActor;
}) {
  return async (tool: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    try {
      if (!AUDIO_TOOL_NAMES.includes(tool) || "url" in args || "userEmail" in args) throw new ValidationError("Invalid audio tool arguments");
      const operation = tool === AUDIO_JOB_TOOL_NAME ? text(args, "operation") : "submit";
      if (operation === "list") {
        const limit = args.limit ?? 20;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("Invalid list limit");
        const jobs = await deps.jobs.list(context.projectName, context.userEmail, limit, text(args, "cursor"));
        return { text: JSON.stringify({ jobs, nextCursor: jobs.length === limit ? jobs.at(-1)!.id : null }) };
      }
      if (operation === "status" || operation === "read") {
        const id = text(args, "job_id");
        if (!id) throw new ValidationError("job_id is required");
        const job = await deps.jobs.get(context.projectName, id, context.userEmail);
        if (operation === "status") return { text: JSON.stringify(job) };
        if (!job.transcriptRef) throw new ValidationError("The transcript is not ready");
        const cursor = text(args, "cursor") ?? "0";
        const limit = args.limit ?? 12_000;
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || typeof limit !== "number" ||
          !Number.isInteger(limit) || limit < 1 || limit > 20_000) throw new ValidationError("Invalid transcript page");
        const file = await deps.files.read(context.projectName, job.transcriptRef, context.userEmail, MAX_TRANSCRIPT_BYTES);
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as { text?: unknown; warnings?: unknown };
        if (typeof body.text !== "string") throw new ValidationError("The stored transcript is invalid");
        const offset = Number(cursor);
        if (offset > body.text.length || (offset > 0 && (body.text.codePointAt(offset - 1) ?? 0) > 0xffff)) {
          throw new ValidationError("Invalid transcript cursor");
        }
        const remaining = body.text.slice(offset);
        // A one-unit page must still advance when its first character is a surrogate pair.
        const content = cutCodePoints(remaining, limit) || cutCodePoints(remaining, 2);
        const next = offset + content.length;
        return { text: JSON.stringify({ text: content, nextCursor: next < body.text.length ? String(next) : null,
          jobStatus: job.status, warnings: Array.isArray(body.warnings) ? body.warnings.filter((warning) => typeof warning === "string") : [] }) };
      }
      if (operation !== "submit") throw new ValidationError("Invalid audio operation");
      const post = object(args, "postprocess"); const destination = object(args, "destination");
      const projectName = post && text(post, "projectName"); const versionName = post && text(post, "versionName");
      if (post && (!projectName || !versionName)) throw new ValidationError("A postprocessing Agent version is required");
      const serverName = destination && text(destination, "serverName");
      if (destination && (!serverName || typeof destination.documents !== "boolean" || typeof destination.memories !== "boolean")) {
        throw new ValidationError("Invalid destination");
      }
      const fileId = text(args, "file_id"); const sourceRef = text(args, "source_ref");
      if ((!fileId && !sourceRef) || (fileId && sourceRef)) throw new ValidationError("Provide exactly one file_id or source_ref");
      const result = await deps.jobs.submit(context.projectName, context.userEmail, {
        source: fileId ? { kind: "file", fileId } : { kind: "source", sourceRef: sourceRef! },
        task: tool === IMPORT_FILE_TOOL_NAME ? "import" : tool === TRANSCRIBE_AUDIO_TOOL_NAME ? "transcribe" : "process",
        model: text(args, "model"), language: text(args, "language"), retention: retention(args.retention),
        processingRevision: text(args, "processing_revision"),
        ...(post ? { postprocess: { projectName: projectName!, versionName: versionName! } } : {}),
        ...(destination ? { destination: { serverName: serverName!, documents: destination.documents as boolean, memories: destination.memories as boolean } } : {}),
      }, { occurrence: context.occurrence, actor: context.actor });
      return { text: JSON.stringify(result) };
    } catch (error) {
      return { text: `Error: ${error instanceof AppError ? error.message : "audio operation failed"}.` };
    }
  };
}
