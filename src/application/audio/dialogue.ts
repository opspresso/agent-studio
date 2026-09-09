import type { TranscriptSegment } from "@/domain/llm/transcription";

interface DialogueInput {
  text: string;
  segments?: TranscriptSegment[];
  language?: string;
}

function literal(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#!|])/g, "\\$1");
}
function quote(text: string): string { return text.split(/\r?\n/).map((line) => `> ${literal(line)}`).join("\n"); }
function time(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  return `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, "0")}:${String(Math.floor(milliseconds / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

/** Render supplied labels and timings only; the full text remains available even with partial segments. */
export function renderDialogue(input: DialogueInput): string {
  const ko = input.language === "ko";
  const unknown = ko ? "화자 미상" : "Unknown speaker";
  const lines = [ko ? "# 대화 내용" : "# Conversation",
    ko ? "화자 표시는 ASR 제공 라벨이며 실명 확인 결과가 아니다. 구간별 라벨만으로 동일 인물인지 판단하지 않는다."
      : "Speaker labels are supplied by ASR, not verified identities. Labels from separate chunks do not establish the same person."];
  if (input.segments?.length) {
    lines.push(ko ? "## 제공된 발화 구간" : "## Supplied segments");
    for (const segment of input.segments) {
      const timing = segment.start !== undefined && segment.end !== undefined
        ? ` (${time(segment.start)}–${time(segment.end)})` : "";
      lines.push(`**${literal(segment.speaker ?? unknown)}${timing}:**\n\n${quote(segment.text)}`);
    }
    lines.push(ko ? "## 전체 전사문" : "## Full transcript", quote(input.text));
  } else lines.push(`**${unknown}:**\n\n${quote(input.text)}`);
  return `${lines.join("\n\n")}\n`;
}
