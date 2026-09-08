/** Agent Memory's existing kinds, shared by the response schema and sink. */
export const AUDIO_MEMORY_KINDS = ["rule", "experience", "decision", "preference", "fact"] as const;
export interface AudioMemoryCandidate {
  kind: (typeof AUDIO_MEMORY_KINDS)[number];
  title: string;
  content: string;
  /** Exact excerpts from the original transcript, not generated summaries. */
  evidence: string[];
}
export interface AudioPostprocessOutput {
  text: string;
  memories: AudioMemoryCandidate[];
  warnings: string[];
}

export const AUDIO_OUTPUT_SCHEMA = {
  name: "audio_result", strict: true,
  schema: { type: "object", properties: {
    text: { type: "string" },
    memories: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: AUDIO_MEMORY_KINDS }, title: { type: "string" }, content: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
    }, required: ["kind", "title", "content", "evidence"], additionalProperties: false } },
    warnings: { type: "array", items: { type: "string" } },
  }, required: ["text", "memories", "warnings"], additionalProperties: false },
};
