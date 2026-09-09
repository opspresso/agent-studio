import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyVersionChange, onVersionChange } from "@/app/projects/lib/versionEvents";

afterEach(() => vi.unstubAllGlobals());
describe("saved version notifications", () => {
  it("refreshes only the affected project and stops after the layout unmounts", () => {
    vi.stubGlobal("window", new EventTarget());
    const reload = vi.fn();
    const stop = onVersionChange("audio", reload);
    notifyVersionChange("other");
    expect(reload).not.toHaveBeenCalled();
    notifyVersionChange("audio");
    expect(reload).toHaveBeenCalledTimes(1);
    stop(); notifyVersionChange("audio");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("does nothing for server-side API consumers", () => {
    vi.stubGlobal("window", undefined);
    expect(() => notifyVersionChange("audio")).not.toThrow();
  });
});
