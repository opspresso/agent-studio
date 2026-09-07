/**
 * What a pile of bytes is, and — when it is nothing this reads — what the
 * refusal says.
 *
 * The refusals are tested as carefully as the successes. A model that is told
 * "unsupported" spends another turn guessing; one that is told "this is an
 * Excel workbook" or "use fetch_document for web pages" does not. Every case
 * below is a wrong answer somebody would otherwise have to debug from a tool
 * result that said nothing.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { detect, extensionOf, looksLikeText } from "@/infrastructure/documents/engine/detect";
import { buildZip, stored } from "@/infrastructure/documents/engine/zip";

const utf8 = (value: string) => new TextEncoder().encode(value);
const OLE = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

function reasonOf(bytes: Uint8Array, mimeType = "", filename?: string): string {
  const detection = detect(bytes, mimeType, filename);
  assert.equal(detection.format, "unsupported", "expected a refusal");
  return detection.format === "unsupported" ? detection.reason : "";
}

test("magic bytes decide, whatever the header said", () => {
  // A `.hwp` behind a download endpoint is served as octet-stream almost always.
  // A header that disagrees with the file's own first bytes is wrong about it.
  const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.equal(detect(ole, "application/octet-stream", "x.bin").format, "hwp");
  assert.equal(detect(ole, "text/plain", "notes.txt").format, "hwp");
});

test("a zip is identified by the part it carries", () => {
  const docx = buildZip({ "word/document.xml": utf8("<w:document/>") });
  const hwpx = buildZip({
    mimetype: stored(utf8("application/hwp+zip")),
    "Contents/section0.xml": utf8("<hp:sec/>"),
  });
  assert.equal(detect(docx, "", undefined).format, "docx");
  assert.equal(detect(hwpx, "", undefined).format, "hwpx");
});

test("a zip is identified by the office format it carries", () => {
  const xlsx = buildZip({ "xl/workbook.xml": utf8("<workbook/>") });
  assert.equal(detect(xlsx, "", undefined).format, "xlsx");
  const pptx = buildZip({ "ppt/presentation.xml": utf8("<p/>") });
  assert.equal(detect(pptx, "", undefined).format, "pptx");
  const odf = buildZip({ mimetype: utf8("application/vnd.oasis.opendocument.text"), "content.xml": utf8("<x/>") });
  assert.equal(detect(odf, "", undefined).format, "odf");
});

test("a zip this does not read is still named rather than dismissed", () => {
  const epub = buildZip({ "META-INF/container.xml": utf8("<container/>") });
  assert.match(reasonOf(epub), /EPUB/);
  const plain = buildZip({ "notes.txt": utf8("hello") });
  assert.match(reasonOf(plain), /zip archive/);
});

test("a compound file is left for the HWP reader to identify", () => {
  // Every Office binary from 97-2003 is one of these too, and telling them
  // apart means reading the directory — which the HWP reader parses anyway.
  assert.equal(detect(OLE, "", "report.doc").format, "hwp");
  assert.equal(detect(OLE, "application/x-hwp", undefined).format, "hwp");
});

test("HWP 3.0 names its version and the way out of it", () => {
  const hwp3 = utf8("HWP Document File V3.00 ");
  const reason = reasonOf(hwp3, "", "old.hwp");
  assert.match(reason, /HWP 3\.0/);
  assert.match(reason, /\.hwpx/);
});

test("a web page goes back to the caller, which converts pages itself", () => {
  assert.match(reasonOf(utf8("<html><body>hi</body></html>"), "text/html"), /an HTML page/);
  assert.match(reasonOf(utf8("<html/>"), "", "page.htm"), /the caller reads for itself/);
});

test("an image is named as an image rather than as an unreadable document", () => {
  assert.match(reasonOf(Uint8Array.from([1, 2, 3, 4]), "image/png"), /an image rather than a document/);
});

test("text is recognised as text, and handed back rather than parsed here", () => {
  // Still recognised — the refusal names the format, which is what stops a
  // caller concluding the document is unreadable — but no longer read here.
  for (const [bytes, mime, name] of [
    [utf8("# Notes\n\nplain text"), "", undefined],
    [utf8('{"a":1}'), "application/json", undefined],
    [utf8("a,b,c\n1,2,3"), "", "data.csv"],
  ] as const) {
    assert.match(reasonOf(bytes, mime, name), /a plain-text document, which the caller reads/);
  }
});

test("EUC-KR bytes are text, though they are not valid UTF-8", () => {
  // Decoding is the decoder's problem. Judging text by whether UTF-8 succeeds
  // would refuse every Korean document written before UTF-8 won.
  const eucKr = Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a, 0x74, 0x65, 0x78, 0x74]);
  assert.match(reasonOf(eucKr, "", "memo.txt"), /a plain-text document/);
  assert.equal(looksLikeText(eucKr), true);
});

test("binary with no signature is refused, and says what was declared", () => {
  const binary = Uint8Array.from(Array.from({ length: 64 }, (_, index) => index % 7));
  assert.match(reasonOf(binary, "application/octet-stream"), /application\/octet-stream/);
  assert.equal(looksLikeText(binary), false);
});

test("an empty document is empty, not unrecognised", () => {
  assert.match(reasonOf(new Uint8Array(0)), /empty/);
});

test("a name that promises one thing and bytes that are another says so", () => {
  // Only for the formats this still parses. A `.pdf` is answered earlier now —
  // whatever its bytes turn out to be, it is not this server's to read.
  assert.match(reasonOf(utf8("hello"), "", "report.docx"), /named \.docx, but its contents are not/);
  assert.match(
    reasonOf(utf8("hello"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    /but its contents are not DOCX/,
  );
});

test("a format the caller reads is refused by name rather than as unrecognised", () => {
  // "Unsupported" would send a model looking for another tool; naming the format
  // and saying who does read it ends the search in one turn.
  for (const [bytes, mime, name] of [
    [utf8("%PDF-1.4 x"), "", "report.pdf"],
    [utf8("hello"), "", "notes.md"],
    [utf8("<html><body>hi</body></html>"), "text/html", "page.html"],
  ] as const) {
    assert.match(reasonOf(bytes, mime, name), /the caller reads for itself/);
  }
});

test("a legacy binary named by its extension is named in the refusal", () => {
  assert.match(reasonOf(utf8("hello"), "", "sheet.xls"), /Excel 97-2003/);
  assert.match(reasonOf(utf8("hello"), "", "old.doc"), /Word 97-2003/);
});

test("a name that promises a format this reads, over bytes that are not it, says so", () => {
  assert.match(reasonOf(utf8("hello"), "", "book.xlsx"), /but its contents are not XLSX/);
  assert.match(reasonOf(utf8("hello"), "", "notes.rtf"), /but its contents are not RTF/);
});

test("extensions are read off the end of a name, case-insensitively", () => {
  assert.equal(extensionOf("report.HWPX"), "hwpx");
  assert.equal(extensionOf("a.b.docx"), "docx");
  assert.equal(extensionOf("noextension"), undefined);
  assert.equal(extensionOf(undefined), undefined);
});

test("unknown format hints do not resolve inherited object properties", () => {
  assert.match(reasonOf(utf8("hello"), "", "notes.constructor"), /plain-text document/);
  for (const mime of ["constructor", "toString", "__proto__"]) {
    assert.match(reasonOf(utf8("hello"), mime), /plain-text document/);
  }
});
