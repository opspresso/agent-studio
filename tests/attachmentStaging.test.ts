import { describe, expect, it } from "vitest";
import { createAttachmentReadEpoch } from "@/app/_components/ImageAttachments";

describe("attachment read epoch", () => {
  it("keeps concurrent reads in the same draft current", () => {
    const epoch = createAttachmentReadEpoch();
    const paste = epoch.capture();
    const drop = epoch.capture();

    expect(paste()).toBe(true);
    expect(drop()).toBe(true);
  });

  it("retires every pending read when the draft is cleared", () => {
    const epoch = createAttachmentReadEpoch();
    const previousDraft = epoch.capture();

    epoch.invalidate();

    expect(previousDraft()).toBe(false);
    expect(epoch.capture()()).toBe(true);
  });
});
