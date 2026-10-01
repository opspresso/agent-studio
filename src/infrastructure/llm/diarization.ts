import { validateSpeakerTimeline, type DiarizationPort, type SpeakerTimeline } from "@/domain/audio/diarization";
import { TranscriptionError } from "@/domain/llm/transcription";
import { readBodyText } from "@/shared/httpBody";
import { MAX_DIARIZATION_INPUT_BYTES } from "@/domain/audio/limits";
import { normalizeAudioMimeType } from "@/domain/audio/formats";

export interface DiarizationConfig { baseUrl: string; token: string; revision: string }
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Deployment-owned private service; model/tool input can never choose its URL. */
export function createDiarizer(config: DiarizationConfig): DiarizationPort {
  let endpoint: URL;
  try {
    endpoint = new URL(`${config.baseUrl.replace(/\/+$/, "")}/diarize`);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !config.token.trim() || /[\r\n]/.test(config.token) ||
      !config.revision.trim() || config.revision.length > 128) throw new Error("Invalid configuration");
  } catch { throw new TranscriptionError("invalid_input", "Diarization service configuration is invalid"); }
  return { async analyze(input, signal) {
    signal?.throwIfAborted();
    const mimeType = normalizeAudioMimeType(input.mimeType);
    if (!input.bytes.length || input.bytes.length > MAX_DIARIZATION_INPUT_BYTES || !mimeType) {
      throw new TranscriptionError("invalid_input", "Diarization audio is invalid");
    }
    const operationSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", redirect: "error", signal: operationSignal,
        headers: { "content-type": mimeType, authorization: `Bearer ${config.token}` },
        body: new Uint8Array(input.bytes) });
    } catch {
      operationSignal.throwIfAborted();
      throw new TranscriptionError("unavailable", "Diarization service request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new TranscriptionError(response.status === 401 || response.status === 403 ? "authentication"
        : response.status === 429 || response.status >= 500 ? "unavailable" : "unsupported",
      `Diarization service returned HTTP ${response.status}`);
    }
    let timeline: SpeakerTimeline;
    try {
      timeline = validateSpeakerTimeline(JSON.parse(await readBodyText(response, MAX_RESPONSE_BYTES)));
      if (timeline.revision !== config.revision) throw new Error("Revision mismatch");
    } catch {
      operationSignal.throwIfAborted();
      throw new TranscriptionError("invalid_response", "Diarization service returned an invalid timeline or revision");
    }
    return timeline;
  } };
}
