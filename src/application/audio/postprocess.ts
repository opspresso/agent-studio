import { createHash } from "node:crypto";
import type { AudioJob } from "@/domain/audio/job";
import { audioSourceProject } from "@/domain/audio/job";
import { AUDIO_MEMORY_KINDS, type AudioPostprocessOutput, type AudioMemoryCandidate } from "@/domain/audio/output";
import type { createSourceFileUseCases } from "@/application/artifact/sourceFiles";
import { cutCodePoints } from "@/shared/utf8Text";
import { AudioJobStepError, type AudioJobStepContext } from "./processJob";
import { MAX_TRANSCRIPT_BYTES } from "./transcribeFile";
import type { AudioTranscript } from "./transcribeFile";
import { renderDialogue } from "./dialogue";
import { validateTranscription } from "@/domain/llm/transcription";

const INPUT_CHARS = 16_000;
const OUTPUT_CHARS = 6_000;
const MAX_CALLS = 64;

export interface AudioPostprocessDeps {
  files: ReturnType<typeof createSourceFileUseCases>;
  run(job: AudioJob, text: string, mode: "extract" | "reduce", maxOutputChars: number, signal: AbortSignal): Promise<string>;
}

export function parseAudioPostprocessOutput(text: string, source: string, maxChars: number): AudioPostprocessOutput {
  try {
    if (text.length > maxChars) throw new Error("Too much output");
    const body = JSON.parse(text) as AudioPostprocessOutput;
    if (!body || typeof body.text !== "string" || !Array.isArray(body.memories) || body.memories.length > 50 ||
      !Array.isArray(body.warnings) || body.warnings.some((warning) => typeof warning !== "string")) throw new Error("Invalid output");
    for (const item of body.memories) {
      if (!item || !AUDIO_MEMORY_KINDS.includes(item.kind) || typeof item.title !== "string" || !item.title.trim() || item.title.length > 500 ||
        typeof item.content !== "string" || !item.content.trim() || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 10 ||
        item.evidence.some((quote) => typeof quote !== "string" || !quote.trim() || !source.includes(quote))) throw new Error("Unverified evidence");
    }
    return { text: body.text, memories: body.memories.map((item) => ({ kind: item.kind, title: item.title,
      content: item.content, evidence: item.evidence })), warnings: body.warnings };
  } catch { throw new AudioJobStepError("postprocess_output_invalid", false); }
}

function chunks(text: string): string[] {
  const result = [];
  for (let offset = 0; offset < text.length;) {
    const part = cutCodePoints(text.slice(offset), INPUT_CHARS);
    result.push(part); offset += part.length;
  }
  return result.length ? result : [""];
}

export function createAudioPostprocessStep(deps: AudioPostprocessDeps) {
  return async (job: AudioJob, context: AudioJobStepContext): Promise<{ draftRef: string; summaryRef: string; dialogueRef: string }> => {
    if (!job.postprocess?.version || !job.transcriptRef) throw new AudioJobStepError("postprocess_configuration_missing", false);
    const file = await deps.files.read(job.task === "postprocess" ? audioSourceProject(job) : job.projectName,
      job.transcriptRef, job.userEmail, MAX_TRANSCRIPT_BYTES, context.signal);
    const transcript = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as AudioTranscript;
    try { validateTranscription(transcript); }
    catch { throw new AudioJobStepError("transcript_invalid", false); }
    let calls = 0;
    const execute = async (text: string, round: number, index: number): Promise<AudioPostprocessOutput> => {
      if (++calls > MAX_CALLS) throw new AudioJobStepError("postprocess_call_limit", false);
      const mode = round === 0 ? "extract" : "reduce";
      const maxChars = mode === "extract" ? OUTPUT_CHARS : Math.min(OUTPUT_CHARS, Math.max(256, Math.floor(text.length / 2)));
      const digest = createHash("sha256").update(JSON.stringify([job.postprocess!.version, text, mode])).digest("hex");
      const id = `${job.id}-post-${round}-${index}`;
      await deps.files.import({ id, projectName: job.projectName, userEmail: job.userEmail,
        filename: "postprocess.json", mimeType: "application/json", retention: job.retention, retainUntil: file.file.retireAt,
        derived: { jobId: job.id, kind: "checkpoint" } }, async () => {
        const output = parseAudioPostprocessOutput(await deps.run(job, text, mode, maxChars, context.signal), transcript.text, maxChars);
        const bytes = new TextEncoder().encode(JSON.stringify({ digest, output }));
        return (async function* () { yield bytes; })();
      }, context.signal);
      const cached = await deps.files.read(job.projectName, id, job.userEmail, MAX_TRANSCRIPT_BYTES, context.signal);
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(cached.bytes)) as { digest: string; output: AudioPostprocessOutput };
      if (value.digest !== digest) throw new AudioJobStepError("postprocess_checkpoint_mismatch", false);
      return parseAudioPostprocessOutput(JSON.stringify(value.output), transcript.text, maxChars);
    };
    let outputs: AudioPostprocessOutput[] = [];
    const extracted: AudioMemoryCandidate[] = [];
    const warnings: string[] = [...(transcript.warnings ?? [])];
    const inputs = chunks(transcript.text);
    if (inputs.length > MAX_CALLS) throw new AudioJobStepError("postprocess_call_limit", false);
    for (const [index, text] of inputs.entries()) {
      const output = await execute(text, 0, index);
      outputs.push(output); extracted.push(...output.memories); warnings.push(...output.warnings);
    }
    for (let round = 1; outputs.length > 1; round++) {
      const previous = outputs.map((output) => JSON.stringify(output)).join("\n");
      const next: AudioPostprocessOutput[] = [];
      for (const [index, text] of chunks(previous).entries()) {
        const output = await execute(text, round, index); next.push(output); warnings.push(...output.warnings);
      }
      if (next.length >= outputs.length && next.map((output) => JSON.stringify(output)).join("\n").length >= previous.length) {
        throw new AudioJobStepError("postprocess_reduction_stalled", false);
      }
      outputs = next;
    }
    const output = outputs[0]!;
    const unique = new Map<string, AudioMemoryCandidate>();
    for (const candidate of extracted) {
      const key = JSON.stringify([candidate.kind, candidate.title, candidate.content]);
      const previous = unique.get(key);
      const evidence = [...new Set([...(previous?.evidence ?? []), ...candidate.evidence])];
      if (evidence.length > 10) throw new AudioJobStepError("memory_evidence_limit", false);
      unique.set(key, { ...candidate, evidence });
    }
    if (unique.size > 50) throw new AudioJobStepError("memory_candidate_limit", false);
    const final: AudioPostprocessOutput = { ...output, memories: [...unique.values()],
      warnings: [...new Set(warnings)] };
    const bytes = new TextEncoder().encode(JSON.stringify(final));
    const id = `${job.id}-draft`;
    await deps.files.import({ id, projectName: job.projectName, userEmail: job.userEmail,
      filename: "result.json", mimeType: "application/json", retention: job.retention, retainUntil: file.file.retireAt,
      derivedFrom: job.transcriptRef, model: job.postprocess.version.model, producedBy: job.postprocess.projectName,
      derived: { jobId: job.id, kind: "draft" } },
    async () => (async function* () { yield bytes; })(), context.signal);
    const summaryRef = `${job.id}-summary`;
    await deps.files.import({ id: summaryRef, projectName: job.projectName, userEmail: job.userEmail,
      filename: "summary.md", mimeType: "text/markdown", retention: job.retention, retainUntil: file.file.retireAt,
      derivedFrom: job.transcriptRef, model: job.postprocess.version.model, producedBy: job.postprocess.projectName,
      derived: { jobId: job.id, kind: "draft" } },
    async () => (async function* () { yield new TextEncoder().encode(final.text); })(), context.signal);
    const dialogueRef = `${job.id}-dialogue`;
    await deps.files.import({ id: dialogueRef, projectName: job.projectName, userEmail: job.userEmail,
      filename: "dialogue.md", mimeType: "text/markdown", retention: job.retention, retainUntil: file.file.retireAt,
      derivedFrom: job.transcriptRef, model: transcript.model, producedBy: job.postprocess.projectName,
      derived: { jobId: job.id, kind: "draft" } },
    async () => (async function* () { yield new TextEncoder().encode(renderDialogue(transcript)); })(), context.signal);
    return { draftRef: id, summaryRef, dialogueRef };
  };
}
