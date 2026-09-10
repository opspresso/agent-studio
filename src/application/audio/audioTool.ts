import { audioToolInputFields } from "./toolDefinitions";
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
  if (value === undefined || value === null) return undefined;
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
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`Invalid ${field}`);
  return value as Record<string, unknown>;
}

/** One bound user and occurrence, shared by all audio calls in an Agent run. */
export function createAudioTool(deps: AudioToolDeps, context: {
  projectName: string; userEmail: string; occurrence: string; actor?: RunActor; producedBy?: string;
}) {
  return async (tool: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    try {
      if (!AUDIO_TOOL_NAMES.includes(tool) || "url" in args || "userEmail" in args) throw new ValidationError("Invalid audio tool arguments");
      if (tool === AUDIO_JOB_TOOL_NAME) {
        if (Object.keys(args).some((key) => key !== "request")) throw new ValidationError("AudioJob accepts only request; select one operation shape");
        args = object(args, "request") ?? {};
      }
      const operation = tool === AUDIO_JOB_TOOL_NAME ? text(args, "operation") : "submit";
      const allowed = audioToolInputFields(tool, operation);
      if (!allowed || Object.keys(args).some((key) => !allowed.includes(key))) {
        throw new ValidationError("Unexpected audio input; use only fields of the selected request shape");
      }
      if (operation === "config") return { text: JSON.stringify(await deps.jobs.configuration(context.projectName, context.userEmail)) };
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
        const kind = text(args, "result_kind") ?? "transcript";
        if (kind !== "transcript" && kind !== "processed") throw new ValidationError("Invalid result_kind");
        const reference = kind === "processed" ? job.draftRef : job.transcriptRef;
        if (job.movedTo && !reference) {
          if (kind === "processed" && !job.movedTo.resultId) throw new ValidationError("The processed result is not available");
          return { text: JSON.stringify({ status: "moved", destination: job.movedTo, jobStatus: job.status }) };
        }
        if (!reference) throw new ValidationError(`The ${kind} result is not ready`);
        const cursor = text(args, "cursor") ?? "0";
        const limit = args.limit ?? 12_000;
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || typeof limit !== "number" ||
          !Number.isInteger(limit) || limit < 1 || limit > 20_000) throw new ValidationError("Invalid transcript page");
        const file = await deps.files.read(kind === "transcript" ? job.transcriptProjectName ?? context.projectName : context.projectName,
          reference, context.userEmail, MAX_TRANSCRIPT_BYTES);
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
      if (!["submit", "process", "postprocess"].includes(operation ?? "")) throw new ValidationError("Invalid audio operation");
      const task = operation === "postprocess" ? "postprocess" : "process";
      const post = object(args, "postprocess"); const destination = object(args, "destination");
      const projectName = post && text(post, "projectName"); const versionName = post && text(post, "versionName");
      if (post && (!projectName || !versionName)) throw new ValidationError("A postprocessing Agent version is required");
      const serverName = destination && text(destination, "serverName");
      if (destination && (!serverName || typeof destination.documents !== "boolean" || typeof destination.memories !== "boolean")) {
        throw new ValidationError("Invalid destination");
      }
      const selectedSource = object(args, "source");
      if (selectedSource && (Object.keys(selectedSource).some((key) => !["kind", "id"].includes(key)) ||
        !["artifact", "file", "source"].includes(String(selectedSource.kind)))) throw new ValidationError("Invalid source kind");
      const sourceId = selectedSource && text(selectedSource, "id");
      const fileId = selectedSource?.kind === "file" ? sourceId : undefined;
      const sourceRef = selectedSource?.kind === "source" ? sourceId : undefined;
      const artifactId = operation === "postprocess" ? text(args, "artifact_id") : selectedSource?.kind === "artifact" ? sourceId : undefined;
      const configRevision = args.config_revision;
      if (tool === AUDIO_JOB_TOOL_NAME && operation === "submit" && configRevision === undefined) throw new ValidationError("Read config first and supply its config_revision");
      if (configRevision !== undefined && (typeof configRevision !== "number" || !Number.isSafeInteger(configRevision) || configRevision <= 0)) {
        throw new ValidationError("Invalid config_revision");
      }
      if ([fileId, sourceRef, artifactId].filter(Boolean).length !== 1) throw new ValidationError("Provide source with kind and a non-empty id; postprocess requires artifact_id");
      const result = await deps.jobs.submit(context.projectName, context.userEmail, {
        source: artifactId ? { kind: "artifact", artifactId } : fileId ? { kind: "file", fileId } : { kind: "source", sourceRef: sourceRef! },
        task: tool === IMPORT_FILE_TOOL_NAME ? "import" : tool === TRANSCRIBE_AUDIO_TOOL_NAME ? "transcribe" :
          task === "postprocess" ? "postprocess" : "process",
        model: text(args, "model"), language: text(args, "language"), retention: args.retention === undefined ? undefined : retention(args.retention),
        ...(configRevision !== undefined ? { configRevision } : {}),
        processingRevision: text(args, "processing_revision"),
        ...(post ? { postprocess: { projectName: projectName!, versionName: versionName! } } : {}),
        ...(destination ? { destination: { serverName: serverName!, documents: destination.documents as boolean, memories: destination.memories as boolean } } : {}),
      }, { occurrence: context.occurrence, actor: context.actor,
        ...(context.producedBy ? { producedBy: context.producedBy } : {}) });
      if (result.status === "busy") {
        const reasons = {
          occurrence_limit: "This Agent run has used its new-job allowance, even if its earlier job completed. Do not retry submissions or poll in this run. Report the existing job and remaining work. In a new run, use AudioJob submit with config_revision to process import, transcription and summary as one durable job.",
          active_limit: "The project has reached its active-job limit. Report the existing job and stop; do not repeatedly poll or submit in this run.",
          conflict: "The project or job changed during submission. No new job was admitted. Report the conflict instead of repeatedly submitting.",
        };
        return { text: `Error: Audio job not admitted (${result.reason}). ${reasons[result.reason]}` };
      }
      return { text: JSON.stringify(result) };
    } catch (error) {
      return { text: `Error: ${error instanceof AppError ? error.message : "audio operation failed"}.` };
    }
  };
}
