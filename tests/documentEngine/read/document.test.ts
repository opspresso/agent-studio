/**
 * Readers report completeness and counts from the original document, even when
 * the text budget cuts output. Both short and oversized HWP/DOCX inputs exercise
 * the public reader result.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import CFB from "cfb";
import { deflateRawSync } from "node:zlib";
import { MAX_EXPANDED_BYTES, MAX_TEXT_CHARS } from "@/infrastructure/documents/engine/limits";
import { renderDocx } from "@/infrastructure/documents/engine/write/docx";
import { parseMarkdown } from "@/infrastructure/documents/engine/markdown";
import { readDocument } from "@/infrastructure/documents/engine/read/document";

const HWPTAG_PARA_TEXT = 0x010 + 51;

/** UTF-16LE, which is how HWP stores a paragraph's characters. */
function units(text: string): Uint8Array {
  return Buffer.from(text, "utf16le");
}

/** Tag in the low 10 bits, level in the next 10, size in the top 12. */
function record(tag: number, payload: Uint8Array): Uint8Array {
  const long = payload.byteLength >= 0xfff;
  const size = long ? 0xfff : payload.byteLength;
  const head = new Uint8Array(long ? 8 : 4);
  const view = new DataView(head.buffer);
  view.setUint32(0, (tag & 0x3ff) | (size << 20), true);
  if (long) {
    view.setUint32(4, payload.byteLength, true);
  }
  return Buffer.concat([head, payload]);
}

/** `FileHeader`: the signature, the version most significant last, and the flags. */
function fileHeader(): Buffer {
  const head = Buffer.alloc(256);
  head.write("HWP Document File", 0, "latin1");
  // 5.0.3.0, and `FLAG_COMPRESSED`.
  head[32] = 0;
  head[33] = 3;
  head[34] = 0;
  head[35] = 5;
  head.writeUInt32LE(0x01, 36);
  return head;
}

/** One compound file with one deflated body section holding these paragraphs. */
function hwp(paragraphs: readonly string[]): Uint8Array {
  const section = deflateRawSync(
    Buffer.concat(paragraphs.map((text) => record(HWPTAG_PARA_TEXT, units(text)))),
  );
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, "FileHeader", fileHeader());
  CFB.utils.cfb_add(container, "BodyText/Section0", Buffer.from(section));
  return new Uint8Array(CFB.write(container, { type: "buffer" }) as Buffer);
}

const source = (bytes: Uint8Array, filename: string) => ({
  bytes,
  mimeType: "",
  label: filename,
  filename,
});

test("a short HWP is reported as all of it, in the format's own units", async () => {
  const result = await readDocument(source(hwp(["첫 문단", "둘째 문단"]), "짧은.hwp"));

  assert.equal(result.format, "hwp");
  assert.equal(result.complete, true);
  assert.match(result.note ?? "", /^all 1 section\(s\) of an HWP 5\.0\.3\.0 document$/);
  assert.deepEqual(result.counts, { blocks: 2, totalBlocks: 2, sections: 1 });
  assert.equal(result.text, "첫 문단\n\n둘째 문단");
});

test("an HWP reader preserves supplementary Unicode alongside Korean text", async () => {
  const text = "한글 😀 and 𝄞";
  const result = await readDocument(source(hwp([text]), "unicode.hwp"));
  assert.equal(result.text, text);
  assert.equal(result.complete, true);
});

test("an HWP past the character budget says how much of it came back", async () => {
  const paragraphs = Array.from({ length: 400 }, (_, index) => `문단${index} ${"가".repeat(500)}`);

  const result = await readDocument(source(hwp(paragraphs), "긴.hwp"));

  assert.ok(result.text.length <= MAX_TEXT_CHARS);
  assert.equal(result.complete, false);
  assert.match(result.note ?? "", /^\d+ of 400 block\(s\) across 1 section\(s\)$/);
  const counts = result.counts as { blocks: number; totalBlocks: number };
  assert.equal(counts.totalBlocks, 400);
  assert.ok(counts.blocks < 400, `wrote ${counts.blocks} of 400 blocks and called it a cut`);
  assert.ok(counts.blocks > 0);
});

test("a DOCX past the character budget says the same thing the same way", async () => {
  const markdown = Array.from({ length: 400 }, (_, index) => `문단${index} ${"가".repeat(500)}`).join(
    "\n\n",
  );
  const bytes = renderDocx(parseMarkdown(markdown), {
    title: "긴 문서",
    created: "2026-01-01T00:00:00.000Z",
  });

  const result = await readDocument(source(bytes, "긴.docx"));

  assert.ok(result.text.length <= MAX_TEXT_CHARS);
  assert.equal(result.complete, false);
  assert.match(result.note ?? "", /^\d+ of \d+ block\(s\)$/);
  const counts = result.counts as { blocks: number; totalBlocks: number };
  assert.ok(counts.blocks < counts.totalBlocks);
});

test("HWP body sections share the document expansion budget", async () => {
  // An ignored record carries the bytes, so parsing the fixture does not need
  // a correspondingly large string or millions of synthetic records.
  const padding = Buffer.alloc(MAX_EXPANDED_BYTES / 2);
  padding.writeUInt32LE(0xfff00010, 0);
  padding.writeUInt32LE(padding.byteLength - 8, 4);
  const section = deflateRawSync(Buffer.concat([
    padding,
    record(HWPTAG_PARA_TEXT, units("kept")),
  ]));
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, "FileHeader", fileHeader());
  CFB.utils.cfb_add(container, "BodyText/Section0", section);
  CFB.utils.cfb_add(container, "BodyText/Section1", section);
  const bytes = new Uint8Array(CFB.write(container, { type: "buffer" }) as Buffer);
  assert.ok(bytes.byteLength < 200_000);
  await assert.rejects(readDocument(source(bytes, "over-budget.hwp")), /expanded body exceeds/);
});

test("HWP sections below the shared budget preserve their document order", async () => {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, "FileHeader", fileHeader());
  for (const [index, text] of ["first", "second"].entries()) {
    CFB.utils.cfb_add(container, `BodyText/Section${index}`, deflateRawSync(record(HWPTAG_PARA_TEXT, units(text))));
  }
  const bytes = new Uint8Array(CFB.write(container, { type: "buffer" }) as Buffer);
  const result = await readDocument(source(bytes, "two-sections.hwp"));
  assert.equal(result.text, "first\n\nsecond");
  assert.equal(result.complete, true);
  assert.equal(result.counts?.sections, 2);
});
