import type { ChannelToolDef } from "@/domain/llm/channel";
import { IMPORT_FILE_TOOL_NAME, TRANSCRIBE_AUDIO_TOOL_NAME, AUDIO_JOB_TOOL_NAME } from "@/domain/llm/toolNames";

type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>): Schema => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });
const optional = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }], description: "Use null when not needed. Never invent a placeholder." });
const text: Schema = { type: "string", minLength: 1 };
const operation = (name: string): Schema => ({ type: "string", enum: [name] });
const retention = object({ unit: { type: "string", enum: ["days", "months"] }, value: { type: "integer", minimum: 1 }, timezone: text });
const processingRevision = optional({ ...text, description: "Only for explicit reprocessing. Reuse this value for retries of the same request." });
const source = object({ kind: { type: "string", enum: ["artifact", "file", "source"] },
  id: { ...text, description: "The returned Artifact ID, stored file ID or opaque source_ref matching kind. Never a URL or external recording ID." } });
const postprocess = object({ projectName: text, versionName: { ...text, description: "Use published to select the deployed version." } });
const destination = object({ serverName: text, documents: { type: "boolean" }, memories: { type: "boolean" } });

/** A nested union keeps query, configured submission and explicit processing inputs separate. */
export const AUDIO_JOB_REQUEST_SCHEMA = object({ request: { anyOf: [
  object({ operation: operation("config") }),
  object({ operation: operation("list"), cursor: optional(text), limit: optional({ type: "integer", minimum: 1, maximum: 100 }) }),
  object({ operation: operation("status"), job_id: text }),
  object({ operation: operation("read"), job_id: text, cursor: optional(text),
    limit: optional({ type: "integer", minimum: 1, maximum: 20_000 }),
    result_kind: optional({ type: "string", enum: ["transcript", "processed"] }) }),
  object({ operation: operation("submit"), source, config_revision: { type: "integer", minimum: 1 }, processing_revision: processingRevision }),
  object({ operation: operation("postprocess"), artifact_id: text, postprocess, retention, processing_revision: processingRevision }),
  object({ operation: operation("process"), source, model: text, language: optional(text), retention,
    postprocess: optional(postprocess), destination: optional(destination), processing_revision: processingRevision }),
] } });

export const AUDIO_TOOL_DEFS: ChannelToolDef[] = [
  { type: "function", function: { name: IMPORT_FILE_TOOL_NAME,
    description: "Store only the original file as an Artifact. For transcription and summary use AudioJob configured submit instead. Returns a durable job ID; it does not resume this Agent.",
    parameters: object({ source, retention, processing_revision: processingRevision }) } },
  { type: "function", function: { name: TRANSCRIBE_AUDIO_TOOL_NAME,
    description: "Import and transcribe audio, without a summary. For the complete workflow use AudioJob configured submit. Transcript Artifacts require AudioJob postprocess, not transcription.",
    parameters: object({ source, model: text, language: optional(text), retention, processing_revision: processingRevision }) } },
  { type: "function", function: { name: AUDIO_JOB_TOOL_NAME,
    description: "Follow the connected audio-processing skill. Select one request shape. config reads project defaults; submit uses that revision for ONE durable import → transcription → configured summary job. postprocess summarizes an existing transcript Artifact. process supplies explicit options only when project defaults are unsuitable. list/status/read inspect jobs and results. Optional values are null. After admission report the real job ID and stop polling; the worker continues independently. Completed jobs are reused unless reprocessing is explicitly requested.",
    parameters: AUDIO_JOB_REQUEST_SCHEMA } },
];

/** The dispatcher rejects foreign fields using the same declarations offered to the model. */
export function audioToolInputFields(name: string, operation?: string): string[] | undefined {
  const root = AUDIO_TOOL_DEFS.find((tool) => tool.function.name === name)?.function.parameters;
  if (!root) return undefined;
  const properties = root.properties as Record<string, Schema>;
  if (name !== AUDIO_JOB_TOOL_NAME) return Object.keys(properties);
  const choices = properties.request!.anyOf as Schema[];
  const selected = choices.find((choice) => {
    const fields = choice.properties as Record<string, Schema>;
    return (fields.operation!.enum as string[]).includes(operation ?? "");
  });
  return selected ? Object.keys(selected.properties as object) : undefined;
}
