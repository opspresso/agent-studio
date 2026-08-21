import { describe, expect, it } from "vitest";
import { buildFileSaver, saveFileResult } from "@/application/execution/saveFileTool";
import { buildAgentTools, SAVE_FILE_TOOL_NAME } from "@/application/llm/agentAssembly";
import { MAX_SAVED_FILE_BYTES, savedFileName } from "@/domain/artifact/types";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";

const HTML = "<!doctype html><title>r</title><p>hi";

function decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf-8");
}

describe("saving a file a run wrote", () => {
  it("returns the bytes the bracket will store", () => {
    const result = saveFileResult({ name: "report", mimeType: "text/html", content: HTML });
    const file = result.files?.[0];

    expect(file).toBeDefined();
    expect(file?.name).toBe("report.html");
    expect(file?.mimeType).toBe("text/html");
    expect(decode(file!.b64)).toBe(HTML);
    // The model is told it exists and told not to say it twice: the file is
    // delivered on its own, and a report pasted into the answer as well is the
    // whole reason the tool exists said back to the reader anyway.
    expect(result.text).toContain("report.html");
    expect(result.text).toContain("do not repeat");
  });

  it("keeps the bare type, so a charset cannot ride onto the row", () => {
    // `artifactObjectKey` matches exactly: a parameter reaching the row stores
    // the file as `.bin` and serves it back with two charsets in one header.
    const result = saveFileResult({
      name: "report",
      mimeType: "TEXT/HTML; charset=euc-kr",
      content: HTML,
    });

    expect(result.files?.[0]?.mimeType).toBe("text/html");
    expect(result.files?.[0]?.name).toBe("report.html");
  });

  it("refuses a type it does not write, and names what it does", () => {
    const result = saveFileResult({ name: "deck", mimeType: "application/pdf", content: "x" });

    expect(result.files).toBeUndefined();
    expect(result.text).toContain("text/html");
    // A refusal that only says no costs a turn. This one says which tool does it.
    expect(result.text).toContain("GenerateImage");
  });

  it("refuses an empty file", () => {
    const result = saveFileResult({ name: "r.html", mimeType: "text/html", content: "" });
    expect(result.files).toBeUndefined();
  });

  it("refuses one over the limit and reports the size", () => {
    const result = saveFileResult({
      name: "big.html",
      mimeType: "text/html",
      content: "a".repeat(MAX_SAVED_FILE_BYTES + 1),
    });

    expect(result.files).toBeUndefined();
    expect(result.text).toContain("1024 KB");
  });

  it("measures bytes rather than characters", () => {
    // Hangul is three bytes a character in UTF-8. A limit read off `length`
    // would accept a file a third over it.
    const content = "가".repeat(MAX_SAVED_FILE_BYTES / 3 + 1);
    expect(saveFileResult({ name: "k.txt", mimeType: "text/plain", content }).files).toBeUndefined();
  });
});

describe("what a saved file is called", () => {
  it("adds the extension its type implies", () => {
    expect(savedFileName("quarterly", "text/csv")).toBe("quarterly.csv");
    expect(savedFileName("quarterly.csv", "text/csv")).toBe("quarterly.csv");
    expect(savedFileName("QUARTERLY.CSV", "text/csv")).toBe("QUARTERLY.CSV");
  });

  it("keeps one segment, so a path cannot travel in a name", () => {
    expect(savedFileName("../../etc/passwd", "text/plain")).toBe("passwd.txt");
    expect(savedFileName("a\\b\\c.txt", "text/plain")).toBe("c.txt");
  });

  it("falls back rather than producing a nameless or hidden file", () => {
    expect(savedFileName("", "text/html")).toBe("file.html");
    expect(savedFileName("...", "text/html")).toBe("file.html");
  });
});

describe("whether the tool is offered at all", () => {
  const storage = {} as ArtifactStorage;

  it("is absent where nothing would keep the file", () => {
    // Announced-and-dropped is the failure this prevents: without storage the
    // bracket strips the bytes and the reader gets a row with no download.
    expect(buildFileSaver({})).toBeUndefined();
    expect(buildFileSaver({ artifacts: storage })).toBeDefined();
  });

  it("reaches the model only when the capability was injected", () => {
    const base = {
      skills: [],
      subagents: [],
      canLoadSkills: false,
      withImageTool: false,
      withEditTool: false,
      withImageTransfer: false,
      withUrlTool: false,
      withSlackTools: false,
    };

    expect(buildAgentTools({ ...base, withSaveFileTool: false }).builtinNames.has(SAVE_FILE_TOOL_NAME)).toBe(false);
    const offered = buildAgentTools({ ...base, withSaveFileTool: true });
    expect(offered.builtinNames.has(SAVE_FILE_TOOL_NAME)).toBe(true);
    expect(offered.tools.some((tool) => tool.function.name === SAVE_FILE_TOOL_NAME)).toBe(true);
  });
});
