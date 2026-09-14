import type { WorkspaceEventData, WorkspaceRun } from "@/domain/workspace/types";
import type { SandboxOutput, WorkspaceRuntimeAdapter } from "@/domain/workspace/ports";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { cutUtf8Bytes } from "@/shared/utf8Text";

export function boundedWorkspaceText(text: string, bytes: number): { text: string; truncated: boolean } {
  const bounded = cutUtf8Bytes(text, bytes);
  return { text: bounded, truncated: bounded !== text };
}

export function boundWorkspaceEvent(event: WorkspaceEventData): WorkspaceEventData[] {
  if (Buffer.byteLength(JSON.stringify(event)) <= WORKSPACE_LIMITS.eventBytes) return [event];
  if ("text" in event) {
    const bounded = boundedWorkspaceText(event.text ?? "", Math.floor(WORKSPACE_LIMITS.eventBytes / 8));
    return [{ ...event, text: bounded.text, ...(event.kind === "diff" ? { truncated: true } : {}) },
      { kind: "warning", text: "Workspace event output was truncated" }];
  }
  if (event.kind === "check") return [{ ...event, check: { ...event.check, output: "", truncated: true } }];
  return [{ kind: "warning", text: "Oversized workspace event was omitted" }];
}

/** Provider output framing and native runtime framing are separate, durable cursors. */
export function foldWorkspaceOutput(
  runtime: WorkspaceRuntimeAdapter,
  run: WorkspaceRun,
  output: SandboxOutput,
  terminal: boolean,
): { events: WorkspaceEventData[]; patch: Partial<WorkspaceRun>; nativeSessionId?: string } {
  const events: WorkspaceEventData[] = [];
  let pending = run.protocolBuffer ?? "";
  const isCheck = run.phase === "checks";
  for (const frame of output.frames) {
    if (frame.stream === "stderr" || runtime.kind === "command" || isCheck) {
      events.push({ kind: "output", ...frame });
    } else {
      pending += frame.text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) events.push(...runtime.events(line));
      if (Buffer.byteLength(pending) > WORKSPACE_LIMITS.diffBytes) {
        events.push({ kind: "warning", text: "Oversized native runtime event was omitted" });
        pending = "";
      }
    }
  }
  if (terminal && pending) { events.push(...runtime.events(pending)); pending = ""; }
  const nativeSessionId = events.filter(event => event.kind === "session").at(-1)?.nativeSessionId;
  const failed = events.find(event => event.kind === "status" && event.status === "failed");
  const patch: Partial<WorkspaceRun> = { outputOffset: output.nextOffset, protocolBuffer: pending,
    ...(failed ? { runtimeFailed: true, error: boundedWorkspaceText("text" in failed ? failed.text ?? "Runtime failed" : "Runtime failed", WORKSPACE_LIMITS.errorBytes).text } : {}) };
  if (isCheck) {
    const index = run.checkIndex ?? 0;
    const current = run.checks[index];
    if (current) {
      const appended = boundedWorkspaceText(current.output + output.frames.map(frame => frame.text).join(""), WORKSPACE_LIMITS.checkOutputBytes);
      patch.checks = run.checks.map((check, at) => at === index ? { ...check, output: appended.text,
        truncated: current.truncated || appended.truncated } : check);
    }
  }
  return { events: events.flatMap(boundWorkspaceEvent), patch, ...(nativeSessionId ? { nativeSessionId } : {}) };
}
