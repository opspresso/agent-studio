import type { AudioJob } from "@/domain/audio/job";
import { audioSourceAgent } from "@/domain/audio/job";
import type { AudioSegmenter } from "@/domain/audio/segmenter";
import { validateSpeakerTimeline, type DiarizationPort, type SpeakerTimeline } from "@/domain/audio/diarization";
import { validateTranscription, type TranscriptionPort, type TranscriptionResult, type TranscriptSegment } from "@/domain/llm/transcription";
import type { createSourceFileUseCases } from "@/application/artifact/sourceFiles";
import { AudioJobStepError, type AudioJobStepContext } from "./processJob";

export const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

export interface AudioTranscript {
  language?: string;
  text: string;
  segments: TranscriptSegment[];
  model: string;
  sourceFileId: string;
  sourceChecksum: string;
  totalSeconds: number;
  coverage: Array<{ start: number; end: number }>;
  warnings: string[];
  usageReceipts: string[];
  /** Whole-recording diarizer provenance; absent for provider/request-scoped labels. */
  diarizationRevision?: string;
}

export interface AudioTranscriptionDeps {
  files: ReturnType<typeof createSourceFileUseCases>;
  segmenter: AudioSegmenter;
  resolve(model: string): Promise<{
    transcriber: TranscriptionPort; segmentSeconds: number; maxSegmentBytes: number; settingsKey: string;
    diarization?: { port: DiarizationPort; revision: string };
  }>;
  /** The run budget owner checks each new provider request, not cached segments. */
  beforeTranscribe(job: AudioJob, audioSeconds: number): Promise<(failed: boolean) => Promise<void>>;
  /** Must record idempotently by the stable segment receipt ID. */
  recordUsage(job: AudioJob, receiptId: string, result: TranscriptionResult): Promise<void>;
}

interface StoredSegment {
  index: number;
  start: number;
  end: number;
  totalSeconds: number;
  sourceChecksum: string;
  model: string;
  segmentSeconds: number;
  maxSegmentBytes: number;
  settingsKey: string;
  language: string | null;
  speaker?: string;
  result: TranscriptionResult;
}

function parseSegment(bytes: Uint8Array, expected: Omit<StoredSegment, "result">): StoredSegment {
  let parsed: StoredSegment;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as StoredSegment;
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid segment");
    for (const [name, value] of Object.entries(expected)) {
      if (parsed[name as keyof StoredSegment] !== value) throw new Error("Segment plan changed");
    }
    if (!parsed.result || typeof parsed.result !== "object") throw new Error("Missing result");
    validateTranscription(parsed.result);
    if (parsed.result.model !== expected.model) throw new Error("Model changed");
    if (parsed.result.segments.some((segment) => segment.end !== undefined && segment.end > expected.end - expected.start + 0.05)) {
      throw new Error("Segment timing exceeds its audio range");
    }
  } catch { throw new AudioJobStepError("transcript_checkpoint_mismatch", false); }
  return parsed;
}

/** Each segment is an immutable file, so retrying a later stage never repeats successful ASR. */
export function createAudioTranscriptionStep(deps: AudioTranscriptionDeps) {
  return async (job: AudioJob, context: AudioJobStepContext): Promise<{ transcriptRef: string }> => {
    if (!job.fileId) throw new AudioJobStepError("missing_file", false);
    const source = await deps.files.read(audioSourceAgent(job), job.fileId, job.userEmail, undefined, context.signal);
    if (!source.file.checksum) throw new AudioJobStepError("missing_checksum", false);
    const config = await deps.resolve(job.model);
    let timeline: SpeakerTimeline | undefined;
    if (config.diarization) {
      const id = `${job.id}-diarization`;
      await deps.files.import({ id, agentName: job.agentName, userEmail: job.userEmail,
        filename: "diarization.json", mimeType: "application/json", retention: job.retention,
        retainUntil: source.file.retireAt, derived: { jobId: job.id, kind: "checkpoint" } }, async () => {
        const value = validateSpeakerTimeline(await config.diarization!.port.analyze({ bytes: source.bytes, mimeType: source.mimeType }, context.signal));
        if (value.revision !== config.diarization!.revision) throw new AudioJobStepError("diarization_revision_mismatch", false);
        const bytes = new TextEncoder().encode(JSON.stringify({ sourceChecksum: source.file.checksum,
          settingsKey: config.settingsKey, timeline: value }));
        if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new AudioJobStepError("transcript_limit", false);
        return (async function* () { yield bytes; })();
      }, context.signal);
      const file = await deps.files.read(job.agentName, id, job.userEmail, MAX_TRANSCRIPT_BYTES, context.signal);
      try {
        const saved = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
        if (saved.sourceChecksum !== source.file.checksum || saved.settingsKey !== config.settingsKey) throw new Error("Plan changed");
        timeline = validateSpeakerTimeline(saved.timeline);
        if (timeline.revision !== config.diarization.revision) throw new Error("Revision changed");
      } catch { throw new AudioJobStepError("diarization_checkpoint_mismatch", false); }
    }
    const parts: StoredSegment[] = [];
    let processedSeconds = 0;
    let checkpointBytes = 0;
    for await (const segment of deps.segmenter.split({ bytes: source.bytes, mimeType: source.mimeType,
      segmentSeconds: config.segmentSeconds, maxSegmentBytes: config.maxSegmentBytes, ...(timeline ? { timeline } : {}) }, context.signal)) {
      context.signal.throwIfAborted();
      if (!parts.length && !job.transcriptionProgress) {
        await context.record({ transcriptionProgress: { processedSeconds: 0, totalSeconds: segment.totalSeconds, completedSegments: 0 } });
      }
      const id = `${job.id}-asr-${segment.index}`;
      const expected = { index: segment.index, start: segment.start, end: segment.end, totalSeconds: segment.totalSeconds,
        sourceChecksum: source.file.checksum, model: job.model, segmentSeconds: config.segmentSeconds,
        maxSegmentBytes: config.maxSegmentBytes, settingsKey: config.settingsKey, language: job.language ?? null,
        ...(segment.speaker ? { speaker: segment.speaker } : {}) };
      let close: ((failed: boolean) => Promise<void>) | undefined;
      let failed = true;
      try {
        await deps.files.import({ id, agentName: job.agentName, userEmail: job.userEmail,
          filename: `segment-${segment.index}.json`, mimeType: "application/json", retention: job.retention,
          retainUntil: source.file.retireAt, derived: { jobId: job.id, kind: "checkpoint" } }, async () => {
          close = await deps.beforeTranscribe(job, segment.end - segment.start);
          context.signal.throwIfAborted();
          const result = await config.transcriber.transcribe({ bytes: segment.bytes, mimeType: segment.mimeType,
            filename: segment.filename, ...(job.language ? { language: job.language } : {}) }, context.signal);
          const bytes = new TextEncoder().encode(JSON.stringify({ ...expected, result } satisfies StoredSegment));
          if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new AudioJobStepError("transcript_limit", false);
          return (async function* () { yield bytes; })();
        }, context.signal);
        const checkpoint = await deps.files.read(job.agentName, id, job.userEmail, MAX_TRANSCRIPT_BYTES, context.signal);
        checkpointBytes += checkpoint.bytes.length;
        if (checkpointBytes > MAX_TRANSCRIPT_BYTES) throw new AudioJobStepError("transcript_limit", false);
        const part = parseSegment(checkpoint.bytes, expected);
        await deps.recordUsage(job, id, part.result);
        parts.push(part);
        processedSeconds += part.end - part.start;
        if (processedSeconds >= (job.transcriptionProgress?.processedSeconds ?? 0)) {
          await context.record({ transcriptionProgress: { processedSeconds, totalSeconds: part.totalSeconds, completedSegments: parts.length } });
        }
        failed = false;
      } finally { await close?.(failed); }
    }
    if (!parts.length) throw new AudioJobStepError("empty_audio", false);
    const segments: TranscriptSegment[] = parts.flatMap((part) => timeline
      ? [{ text: part.result.text, start: part.start, end: part.end, ...(part.speaker ? { speaker: part.speaker } : {}) }]
      : part.result.segments.map((segment) => ({
      ...segment,
      ...(segment.start !== undefined && segment.end !== undefined ? {
        start: part.start + segment.start, end: part.start + segment.end,
      } : {}),
      // Separate requests cannot establish that their label A refers to the same person.
      ...(segment.speaker ? { speaker: `${part.index}:${segment.speaker}` } : {}),
    })));
    const output: AudioTranscript = {
      ...(job.language ? { language: job.language } : {}),
      text: parts.map((part) => part.result.text).join("\n"), segments, model: job.model,
      sourceFileId: job.fileId, sourceChecksum: source.file.checksum,
      totalSeconds: parts[0]!.totalSeconds,
      coverage: parts.map(({ start, end }) => ({ start, end })),
      warnings: [...new Set([...parts.flatMap((part) => part.result.warnings), ...(timeline?.warnings ?? []),
        ...(timeline && parts.some(part => !part.speaker) ? ["Some audio intervals have no detected speaker; attribution is unknown."] : [])])],
      usageReceipts: parts.map((part) => `${job.id}-asr-${part.index}`),
      ...(timeline ? { diarizationRevision: timeline.revision } : {}),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(output));
    if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new AudioJobStepError("transcript_limit", false);
    const id = `${job.id}-transcript`;
    await deps.files.import({ id, agentName: job.agentName, userEmail: job.userEmail,
      filename: "transcript.json", mimeType: "application/json", retention: job.retention, retainUntil: source.file.retireAt,
      derivedFrom: job.fileId, model: job.model, producedBy: job.producedBy,
      derived: { jobId: job.id, kind: "transcript" } },
    async () => (async function* () { yield bytes; })(), context.signal);
    return { transcriptRef: id };
  };
}
