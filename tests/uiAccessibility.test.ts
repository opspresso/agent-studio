import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("console accessibility", () => {
  it("names the shared catalog search and mobile navigation controls", () => {
    expect(source("src/app/_components/CatalogSearch.tsx")).toContain(
      "aria-label={placeholder}",
    );
    expect(source("src/components/AppLayout.tsx")).toContain(
      'aria-label={t(opened ? "chrome.closeNavigation" : "chrome.openNavigation")}',
    );
  });

  it("reports the state of shared disclosure rows", () => {
    expect(source("src/app/_components/ToolRow.tsx")).toContain("aria-expanded={open}");
    expect(source("src/app/_components/ReasoningRow.tsx")).toContain(
      "aria-expanded={shown}",
    );
  });

  it("puts image preview clicks on keyboard-operable buttons", () => {
    const previews = [
      "src/app/chats/_components/parts.tsx",
      "src/app/artifacts/_components/ArtifactGallery.tsx",
      "src/app/projects/[name]/_components/RunPanel.tsx",
      "src/app/projects/[name]/compare/page.tsx",
    ].map(source);

    for (const preview of previews) {
      expect(preview).toContain("<UnstyledButton");
      const imageTags = preview.match(/<Image\b[\s\S]*?\/>/g) ?? [];
      expect(imageTags.every((tag) => !tag.includes("onClick="))).toBe(true);
    }
  });
});
