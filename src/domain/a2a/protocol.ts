/** Small constructors/readers for A2A 1.0's protobuf-native core shapes. */

export interface PartLike {
  content?:
    | { $case: "text"; value: string }
    | { $case: "raw"; value: Buffer }
    | { $case: "url"; value: string }
    | { $case: "data"; value: Record<string, unknown> };
  metadata: Record<string, unknown> | undefined;
  filename: string;
  mediaType: string;
}

export function textPart(text: string): PartLike {
  return {
    content: { $case: "text" as const, value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

export function rawPart(bytesBase64: string, mediaType: string, filename = ""): PartLike {
  return {
    content: { $case: "raw" as const, value: Buffer.from(bytesBase64, "base64") },
    metadata: undefined,
    filename,
    mediaType,
  };
}

export function urlPart(url: string, mediaType: string, filename = ""): PartLike {
  return {
    content: { $case: "url" as const, value: url },
    metadata: undefined,
    filename,
    mediaType,
  };
}

export function partText(part: PartLike): string {
  return part.content?.$case === "text" ? part.content.value : "";
}

export function userMessage(
  messageId: string,
  parts: PartLike[],
  options: { contextId?: string; taskId?: string } = {},
) {
  return {
    messageId,
    contextId: options.contextId ?? "",
    taskId: options.taskId ?? "",
    role: 1 as const, // ROLE_USER
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function agentMessage(messageId: string, contextId: string, taskId: string, text: string) {
  return {
    messageId,
    contextId,
    taskId,
    role: 2 as const, // ROLE_AGENT
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function artifact(artifactId: string, parts: PartLike[]) {
  return {
    artifactId,
    name: artifactId,
    description: "",
    parts,
    metadata: undefined,
    extensions: [],
  };
}

export function taskStatus<TState extends number, TMessage>(state: TState, message?: TMessage) {
  return { state, message, timestamp: new Date().toISOString() };
}
