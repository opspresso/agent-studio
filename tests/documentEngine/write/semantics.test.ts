/**
 * The recognition rules, tested at the boundary that matters: what matches.
 *
 * Every rule is conservative by design, so most of these tests are about what
 * must *not* match — the cost of a wrong treatment is content misrepresented,
 * which is worse than plain rendering.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseMarkdown } from "@/infrastructure/documents/engine/markdown";
import { figureOf, forceSemantic, recognise } from "@/infrastructure/documents/engine/write/semantics";

function detect(markdown: string) {
  const { blocks } = parseMarkdown(markdown);
  const [first, ...rest] = blocks;
  assert.ok(first?.kind === "heading");
  return recognise(first.runs, rest);
}

test("two to four sub-headings with short lines are cards", () => {
  const semantic = detect(
    "## 핵심 가치\n\n### Automation\n\n반복 작업 자동화\n\n### Integration\n\nMCP 기반 연결\n\n### Intelligence\n\nLLM 기반 판단",
  );
  assert.equal(semantic?.kind, "cards");
  assert.ok(semantic?.kind === "cards" && semantic.cards.length === 3);
  assert.ok(semantic?.kind === "cards" && semantic.cards[1]?.body !== undefined);
});

test("a heading without a line still makes a card, but one heading is not a set", () => {
  assert.equal(detect("## 구성\n\n### 하나\n\n### 둘")?.kind, "cards");
  assert.equal(detect("## 구성\n\n### 하나\n\n설명"), undefined);
});

test("a code block or a list under a sub-heading keeps the section as content", () => {
  assert.equal(detect("## s\n\n### A\n\n```\ncode\n```\n\n### B\n\nb"), undefined);
  assert.equal(detect("## s\n\n### A\n\n- 항목\n\n### B\n\nb"), undefined);
});

test("five headings are a list of topics, not a row of cards", () => {
  assert.equal(detect("## s\n\n### 1\n\n### 2\n\n### 3\n\n### 4\n\n### 5"), undefined);
});

test("short numeric bullets are metrics, figure leading or trailing", () => {
  const leading = detect("## 주요 성과\n\n- 99.99% Availability\n- 43% Cost Reduction\n- 2.4x Deployment Speed");
  assert.equal(leading?.kind, "metrics");
  assert.ok(leading?.kind === "metrics" && leading.metrics[0]?.value === "99.99%");
  const trailing = detect("## 성과\n\n- 가용성 99.99%\n- 절감률 43%");
  assert.equal(trailing?.kind, "metrics");
  assert.ok(trailing?.kind === "metrics" && trailing.metrics[0]?.value === "99.99%");
});

test("a list is not metrics when its lines are prose, numbered, or figure-free", () => {
  assert.equal(detect("## s\n\n- 지표를 개선했다\n- 비용을 줄였다"), undefined);
  assert.equal(detect("## s\n\n1. 99% a\n2. 43% b"), undefined, "an ordered list is a sequence");
  assert.equal(
    detect("## s\n\n- 99.99% 가용성을 확보해 어떤 상황에도 서비스가 계속된다는 뜻이다\n- 43% 절감"),
    undefined,
    "a long line is a sentence, not a metric",
  );
});

test("a lone block quote is a pulled quote, with at most a line of attribution", () => {
  const bare = detect("## 고객의 말\n\n> 도입 후 반복 업무가 사라졌다.");
  assert.equal(bare?.kind, "quote");
  const attributed = detect("## 고객의 말\n\n> 도입 후 반복 업무가 사라졌다.\n\n— 운영팀 리드");
  assert.equal(attributed?.kind, "quote");
  assert.ok(attributed?.kind === "quote" && attributed.attribution !== undefined);
  assert.equal(
    detect("## s\n\n> 인용\n\n이어지는 본문 문단이 인용을 논증의 일부로 만든다. 이 문단은 충분히 길어서 출처 표기로 볼 수 없다."),
    undefined,
  );
});

test("a vs-titled pair of sub-headings is a comparison; without vs it is cards", () => {
  const markdown = (title: string) =>
    `## ${title}\n\n### IRSA\n\n- 표준 방식\n- 넓은 지원\n\n### Pod Identity\n\n- 간단한 설정\n- 신규 권장`;
  const compared = detect(markdown("IRSA vs Pod Identity"));
  assert.equal(compared?.kind, "comparison");
  assert.ok(compared?.kind === "comparison" && compared.columns[0].lines.length === 2);
  const plain = detect(markdown("인증 방식"));
  assert.notEqual(plain?.kind, "comparison");
});

test("three to five short ordered steps are a process", () => {
  const semantic = detect("## 도입 절차\n\n1. 접수 자동 분류\n2. 초안 자동 생성\n3. 담당자 검토\n4. 자동 발송");
  assert.equal(semantic?.kind, "process");
  assert.ok(semantic?.kind === "process" && semantic.steps.length === 4);
});

test("a process refuses long steps, few steps, many steps and nesting", () => {
  assert.equal(detect("## s\n\n1. 하나\n2. 둘"), undefined, "two steps are not a flow");
  assert.equal(detect("## s\n\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f"), undefined, "six steps");
  assert.equal(detect("## s\n\n1. a\n  1. a1\n2. b\n3. c"), undefined, "nesting is structure");
  assert.equal(
    detect("## s\n\n1. 이 단계는 노드 하나에 들어가기에는 지나치게 긴 문장으로 쓰여 있어 흐름도가 아니라 문단이다\n2. b\n3. c"),
    undefined,
    "a long step is prose",
  );
});

test("an ordered list whose every step opens with a date is a timeline", () => {
  const semantic = detect("## 로드맵\n\n1. Q1 파일럿 운영\n2. Q2 보안 검토\n3. Q3 전사 배포");
  assert.equal(semantic?.kind, "timeline");
  assert.ok(semantic?.kind === "timeline" && semantic.milestones[0]?.when === "Q1");
  const korean = detect("## 일정\n\n1. 3월 파일럿\n2. 6월 확대\n3. 9월 전사 적용");
  assert.equal(korean?.kind, "timeline");
});

test("one undated step turns a timeline back into a process", () => {
  const semantic = detect("## 일정\n\n1. Q1 파일럿\n2. 보안 검토\n3. Q3 배포");
  assert.equal(semantic?.kind, "process");
});

test("a comparison needs exactly two columns with something in each", () => {
  assert.equal(detect("## A vs B\n\n### A\n\n- a"), undefined, "one column");
  assert.equal(detect("## A vs B\n\n### A\n\n- a\n\n### B\n\n- b\n\n### C\n\n- c"), undefined, "three columns");
  assert.equal(detect("## A vs B\n\n### A\n\n### B\n\n- b"), undefined, "an empty column");
});

test("comparison layouts do not discard list order or nesting", () => {
  for (const list of ["1. first\n2. second", "- parent\n  - child"]) {
    const source = `## A vs B\n\n### A\n\n${list}\n\n### B\n\n- other`;
    assert.equal(detect(source), undefined);
    const [, ...body] = parseMarkdown(source).blocks;
    assert.equal(forceSemantic("comparison", body), undefined);
  }
});

test("a figure is one asset image standing alone, and nothing else", () => {
  const [alone] = parseMarkdown("![전체 구조](asset://d.png)").blocks;
  assert.deepEqual(figureOf(alone), { asset: "d.png", caption: [{ text: "전체 구조" }] });
  const [prose] = parseMarkdown("앞 텍스트 ![그림](asset://d.png)").blocks;
  assert.equal(figureOf(prose), undefined, "an image inside prose is an aside");
  const [web] = parseMarkdown("![그림](https://example.com/a.png)").blocks;
  assert.equal(figureOf(web), undefined, "a web image has no bytes to embed");
});

test("HANGUL matches Korean and only Korean", async () => {
  const { HANGUL } = await import("@/infrastructure/documents/engine/write/semantics");
  assert.ok(HANGUL.test("보고서"));
  assert.ok(HANGUL.test("ㅋㅋ"), "compatibility jamo count");
  assert.ok(HANGUL.test("힣"), "the last syllable is inside the range");
  // A single range from jamo to syllables would span the kana and han blocks
  // between them — Japanese and Chinese must never test as Korean.
  assert.equal(HANGUL.test("日本語のドキュメント"), false);
  assert.equal(HANGUL.test("中文文档"), false);
  assert.equal(HANGUL.test("English only"), false);
});
