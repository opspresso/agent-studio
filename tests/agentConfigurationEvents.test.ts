import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyConfigurationChange, onConfigurationChange } from "@/app/agents/lib/configurationEvents";

afterEach(() => vi.unstubAllGlobals());
describe("saved configuration notifications", () => {
  it("refreshes only the affected agent and stops after the layout unmounts", () => {
    vi.stubGlobal("window", new EventTarget());
    const reload = vi.fn();
    const stop = onConfigurationChange("audio", reload);
    notifyConfigurationChange("other");
    expect(reload).not.toHaveBeenCalled();
    notifyConfigurationChange("audio");
    expect(reload).toHaveBeenCalledTimes(1);
    stop(); notifyConfigurationChange("audio");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("does nothing for server-side API consumers", () => {
    vi.stubGlobal("window", undefined);
    expect(() => notifyConfigurationChange("audio")).not.toThrow();
  });
});
