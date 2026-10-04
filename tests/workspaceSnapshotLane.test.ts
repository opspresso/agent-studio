import { describe, expect, it } from "vitest";
import { withWorkspaceSnapshot } from "@/application/workspace/snapshotLane";

describe("Workspace snapshot memory bound", () => {
  it("loads at most two snapshot payloads and releases a failed operation's permit", async () => {
    const entered: number[] = [];
    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    const first = withWorkspaceSnapshot(async () => {
      entered.push(1);
      await new Promise<void>(resolve => { finishFirst = resolve; });
    });
    const second = withWorkspaceSnapshot(async () => {
      entered.push(2);
      await new Promise<void>((_resolve, reject) => { failSecond = reject; });
    });
    const third = withWorkspaceSnapshot(async () => { entered.push(3); return "loaded"; });
    await Promise.resolve();
    expect(entered).toEqual([1, 2]);
    const rejected = expect(second).rejects.toThrow("Store unavailable");
    failSecond(new Error("Store unavailable"));
    await rejected;
    expect(await third).toBe("loaded");
    finishFirst();
    await first;
    expect(entered).toEqual([1, 2, 3]);
  });
});
