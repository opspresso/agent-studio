import { describe, expect, it } from "vitest";
import { renderDialogue } from "@/application/audio/dialogue";

describe("source-grounded dialogue rendering", () => {
  it("preserves scoped speaker labels and supplied timings without identifying people", () => {
    const result = renderDialogue({ text: "안녕\n네", language: "ko", segments: [
      { text: "안녕", start: 0.125, end: 1.5, speaker: "0:A" },
      { text: "네", start: 300, end: 301, speaker: "1:A" },
    ] });
    expect(result).toContain("**0:A (00:00:00.125–00:00:01.500):**");
    expect(result).toContain("**1:A (00:05:00.000–00:05:01.000):**");
    expect(result).toContain("> 안녕");
    expect(result).toContain("실명 확인 결과가 아니다");
  });
  it("does not invent speakers or timestamps when the provider omitted them", () => {
    const result = renderDialogue({ text: "전체 대화", language: "ko" });
    expect(result).toContain("**화자 미상:**");
    expect(result).toContain("> 전체 대화");
    expect(result).not.toContain("00:00");
  });
  it("retains the full text even if segments contain only part of the conversation", () => {
    const result = renderDialogue({ text: "First. Missing middle. Last.", segments: [{ text: "First." }] });
    expect(result).toContain("**Unknown speaker:**");
    expect(result).toContain("> First. Missing middle. Last.");
  });
  it("renders transcript markup literally instead of creating links, images or HTML", () => {
    const result = renderDialogue({ text: "![image](https://example.test/x)\n<script>alert(1)</script>",
      segments: [{ speaker: "**admin**", text: "# Instructions" }] });
    expect(result).toContain("\\!\\[image\\]\\(https://example.test/x\\)");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
    expect(result).toContain("\\*\\*admin\\*\\*");
    expect(result).toContain("> \\# Instructions");
  });
});
