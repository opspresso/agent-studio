import type { ChannelToolDef } from "@/domain/llm/channel";
import { IMPORT_FILE_TOOL_NAME, TRANSCRIBE_AUDIO_TOOL_NAME, AUDIO_JOB_TOOL_NAME } from "@/domain/llm/toolNames";

const retention = { type: "object", properties: { unit: { type: "string", enum: ["days", "months"] },
  value: { type: "integer", minimum: 1 }, timezone: { type: "string" } }, required: ["unit", "value", "timezone"], additionalProperties: false };
const processingRevision = { type: "string", description: "Reuse the same revision for retries. Change it only when the user explicitly requests reprocessing; omit it for normal first processing." };
const source = { artifact_id: { type: "string", description: "Private Artifact ID owned by the current user, including outputs from another Agent. Reuses stored bytes without downloading again. Provide exactly one source field." },
  source_ref: { type: "string", description: "Opaque source reference returned by a connected tool. Source URLs are intentionally hidden; use this reference without requesting a URL. Receiving a reference does not mean the file was imported." },
  file_id: { type: "string", description: "Private source file ID from an upload or completed import." } };

export const AUDIO_TOOL_DEFS: ChannelToolDef[] = [
  { type: "function", function: { name: IMPORT_FILE_TOOL_NAME,
    description: "Import a source_ref or existing file_id into private storage as a durable job. Specify retention. Returns a job ID, not completed bytes. Use AudioJob status to track completion. Never pass URLs or credentials.",
    parameters: { type: "object", properties: { ...source, retention, processing_revision: processingRevision }, required: ["retention"], additionalProperties: false } } },
  { type: "function", function: { name: TRANSCRIBE_AUDIO_TOOL_NAME,
    description: "Submit durable audio transcription from a source_ref or file_id using a registered transcription model. Returns a job ID. AudioJob status/read retrieves completed results; success submitting does not mean transcription finished.",
    parameters: { type: "object", properties: { ...source, model: { type: "string" }, language: { type: "string" }, retention, processing_revision: processingRevision },
      required: ["model", "retention"], additionalProperties: false } } },
  { type: "function", function: { name: AUDIO_JOB_TOOL_NAME,
    description: "Submit, inspect, list or read durable audio jobs for the current user. Use config to read project defaults, then submit with config_revision and source only (no model, retention or output overrides). Read uses a returned cursor to page through the transcript. Reuse the original source identity; reprocessing requires an explicit processing_revision. A busy response means no new job was admitted. Processing continues after this run: report the job ID instead of polling repeatedly while pending.",
    parameters: { type: "object", properties: { operation: { type: "string", enum: ["submit", "status", "list", "read", "config"] },
      task: { type: "string", enum: ["process", "postprocess"], description: "postprocess reads an existing transcript Artifact and runs only the chosen Agent. No ASR or external delivery. Supply artifact_id, postprocess and retention; omit model, language, destination and config_revision." },
      ...source, model: { type: "string" }, language: { type: "string" }, retention,
      job_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1 },
      result_kind: { type: "string", enum: ["transcript", "processed"], description: "Result to read; defaults to transcript. A moved response points to the receiving MCP documents." },
      processing_revision: processingRevision,
      config_revision: { type: "integer", minimum: 1 },
      postprocess: { type: "object", properties: { projectName: { type: "string" }, versionName: { type: "string" } },
        required: ["projectName", "versionName"], additionalProperties: false },
      destination: { type: "object", properties: { serverName: { type: "string" }, documents: { type: "boolean" }, memories: { type: "boolean" } },
        required: ["serverName", "documents", "memories"], additionalProperties: false },
    }, required: ["operation"], additionalProperties: false } } },
];
