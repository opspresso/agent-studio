import { describe, expect, it } from "vitest";
import { observeWorkspacePage } from "@/application/workspace/output";

describe("Workspace output observation", () => {
  it("requires the unread gap before acknowledging a terminal task", () => {
    const last = observeWorkspacePage([[0, 2]], { after: 4, next: 6, status: "succeeded", hasMore: false, truncated: false, outputLoss: false });
    expect(last.complete).toBe(false);
    const gap = observeWorkspacePage(last.ranges, { after: 2, next: 6, status: "succeeded", hasMore: false, truncated: false, outputLoss: false });
    expect(gap.complete).toBe(true);
  });

  it("does not acknowledge a completed task with permanently omitted output", () => {
    const page = observeWorkspacePage([], { after: 0, next: 6, status: "succeeded", hasMore: false, truncated: false, outputLoss: true });
    expect(page.complete).toBe(false);
  });
});
