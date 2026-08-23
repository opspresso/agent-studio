import { describe, expect, it, vi } from "vitest";
import { onFilePaste } from "@/app/_components/ImageAttachments";

/**
 * A clipboard, as the paste handler reads one: the types it advertises and the
 * files it carries. Nothing here needs a DOM — the handler only reads
 * `types`/`files` and calls `preventDefault`, which is what makes the rule
 * testable at all.
 */
function clipboard(types: string[], files: Array<{ name: string }>) {
  const prevented = { value: false };
  const event = {
    clipboardData: { types, files },
    preventDefault: () => {
      prevented.value = true;
    },
  } as unknown as React.ClipboardEvent;
  return { event, prevented };
}

const picture = { name: "screenshot.png" };

describe("paste-to-attach", () => {
  it("stages a clipboard that carries only files", () => {
    const onFiles = vi.fn();
    const { event, prevented } = clipboard(["Files"], [picture]);
    onFilePaste(onFiles)(event);
    expect(onFiles).toHaveBeenCalledWith([picture]);
    expect(prevented.value).toBe(true);
  });

  /**
   * Chrome's "Copy image", and the same gesture in Slack or Notion. The
   * `text/html` beside the bytes is an `<img>` tag describing the picture —
   * refusing it left the reader with no attachment *and* nothing pasted.
   */
  it("stages a picture whose only text is the markup describing it", () => {
    const onFiles = vi.fn();
    const { event, prevented } = clipboard(["text/html", "Files"], [picture]);
    onFilePaste(onFiles)(event);
    expect(onFiles).toHaveBeenCalledWith([picture]);
    expect(prevented.value).toBe(true);
  });

  /**
   * A spreadsheet range, a slide, a Figma frame: the rendered picture rides
   * along, but the words are what was copied.
   */
  it("leaves a clipboard carrying real text alone", () => {
    const onFiles = vi.fn();
    const { event, prevented } = clipboard(
      ["text/plain", "text/html", "Files"],
      [{ name: "image.png" }],
    );
    onFilePaste(onFiles)(event);
    expect(onFiles).not.toHaveBeenCalled();
    expect(prevented.value).toBe(false);
  });

  it("leaves a text-only clipboard alone", () => {
    const onFiles = vi.fn();
    const { event, prevented } = clipboard(["text/plain"], []);
    onFilePaste(onFiles)(event);
    expect(onFiles).not.toHaveBeenCalled();
    expect(prevented.value).toBe(false);
  });

  /** Disabled means a reply is running: the composer takes nothing, quietly. */
  it("takes nothing while disabled", () => {
    const onFiles = vi.fn();
    const { event, prevented } = clipboard(["Files"], [picture]);
    onFilePaste(onFiles, true)(event);
    expect(onFiles).not.toHaveBeenCalled();
    expect(prevented.value).toBe(false);
  });
});
