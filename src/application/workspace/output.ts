import { isTerminalWorkspaceRun, type WorkspaceEventData, type WorkspaceRun } from "@/domain/workspace/types";
import type { SandboxOperation, SandboxOutput, WorkspaceRuntimeAdapter } from "@/domain/workspace/ports";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { cutUtf8Bytes } from "@/shared/utf8Text";

export function boundedWorkspaceText(text: string, bytes: number): { text: string; truncated: boolean } {
  const bounded = cutUtf8Bytes(text, bytes);
  return { text: bounded, truncated: bounded !== text };
}

/** A terminal task is observed only after every uncut output page has been delivered. */
export function observeWorkspacePage(ranges: Array<[number, number]>, page: {
  after: number; next: number; status: WorkspaceRun["status"]; hasMore: boolean; truncated: boolean; outputLoss: boolean;
}): { ranges: Array<[number, number]>; complete: boolean } {
  if (page.outputLoss || page.truncated || !Number.isSafeInteger(page.after) || page.after < 0 ||
    !Number.isSafeInteger(page.next) || page.next < page.after) return { ranges, complete: false };
  const merged: Array<[number, number]> = [];
  for (const range of [...ranges, [page.after, page.next] as [number, number]].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return { ranges: merged, complete: isTerminalWorkspaceRun(page.status) && page.hasMore === false &&
    merged[0]?.[0] === 0 && merged[0][1] === page.next };
}

export function boundWorkspaceEvent(event: WorkspaceEventData): WorkspaceEventData[] {
  if (Buffer.byteLength(JSON.stringify(event)) <= WORKSPACE_LIMITS.eventBytes) return [event];
  if ("text" in event) {
    const bounded = boundedWorkspaceText(event.text ?? "", Math.floor(WORKSPACE_LIMITS.eventBytes / 8));
    return [{ ...event, text: bounded.text, ...(event.kind === "diff" ? { truncated: true } : {}),
      ...(event.kind === "output" || event.kind === "message" ? { outputLoss: true as const } : {}) },
      { kind: "warning", text: "Workspace event output was truncated" }];
  }
  if (event.kind === "check") return [{ ...event, check: { ...event.check, output: "", truncated: true } }];
  return [{ kind: "warning", text: "Oversized workspace event was omitted", outputLoss: true }];
}

/** Provider output framing and native runtime framing are separate, durable cursors. */
export function foldWorkspaceOutput(
  runtime: WorkspaceRuntimeAdapter,
  run: WorkspaceRun,
  output: SandboxOutput,
  terminal: boolean,
  operation: Pick<SandboxOperation, "truncated">,
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
        events.push({ kind: "warning", text: "Oversized native runtime event was omitted", outputLoss: true });
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
  const bounded = events.flatMap(boundWorkspaceEvent);
  if (operation.truncated || bounded.some(event => event.outputLoss)) patch.outputLoss = true;
  return { events: bounded, patch, ...(nativeSessionId ? { nativeSessionId } : {}) };
}
