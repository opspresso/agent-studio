/**
 * The container guard.
 *
 * A zip is the one input here where a small upload can ask for an arbitrarily
 * large allocation, so the budget is checked against what the central directory
 * *declares* — before anything is inflated. `checkBudget` is exercised directly
 * on those declarations, because building an archive that really expands to
 * 100MB to prove the check works would cost the memory the check exists to
 * refuse.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  MAX_COMPRESSION_RATIO,
  MAX_EXPANDED_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
} from "@/infrastructure/documents/engine/limits";
import { buildZip, checkBudget, listEntries, looksLikeZip, openZip, readEntries, stored, ZipError } from "@/infrastructure/documents/engine/zip";

const utf8 = (value: string) => new TextEncoder().encode(value);

test("what is built can be listed and read back", () => {
  const bytes = buildZip({
    "word/document.xml": utf8("<w:document/>"),
    "docProps/core.xml": utf8("<core/>"),
  });
  assert.ok(looksLikeZip(bytes));
  assert.deepEqual(
    listEntries(bytes).map((entry) => entry.name).sort(),
    ["docProps/core.xml", "word/document.xml"],
  );
  const read = readEntries(bytes, ["word/document.xml"]);
  assert.equal(new TextDecoder().decode(read.get("word/document.xml")), "<w:document/>");
  // Asked for one, inflated one: the filter is what keeps a large archive from
  // being decompressed to answer a question about one part of it.
  assert.equal(read.size, 1);
});

test("a stored entry keeps its bytes and its place at the front", () => {
  // HWPX depends on both: `mimetype` first and uncompressed, the rule ODF
  // packaging uses, and a reader that checks for it checks at a fixed offset.
  const bytes = buildZip({
    mimetype: stored(utf8("application/hwp+zip")),
    "Contents/section0.xml": utf8("<hp:sec/>"),
  });
  assert.equal(listEntries(bytes)[0]?.name, "mimetype");
  assert.equal(
    Buffer.from(bytes.subarray(30, 30 + "mimetype".length)).toString("latin1"),
    "mimetype",
  );
  assert.equal(
    new TextDecoder().decode(readEntries(bytes, ["mimetype"]).get("mimetype")),
    "application/hwp+zip",
  );
});

test("a name that is absent is absent, not an error", () => {
  const bytes = buildZip({ "a.xml": utf8("<a/>") });
  assert.equal(readEntries(bytes, ["missing.xml"]).size, 0);
});

test("bytes that are not a zip are refused with a reason", () => {
  assert.equal(looksLikeZip(utf8("%PDF-1.7")), false);
  assert.throws(() => listEntries(utf8("not a zip at all")), ZipError);
});

test("an empty archive has nothing to read and says so", () => {
  assert.throws(() => checkBudget([]), (error: unknown) =>
    error instanceof ZipError && /empty/.test(error.message));
});

test("too many entries is refused before any of them is inflated", () => {
  const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => ({
    name: `part${index}.xml`,
    compressedSize: 1,
    originalSize: 1,
  }));
  assert.throws(() => checkBudget(entries), (error: unknown) =>
    error instanceof ZipError && /entries/.test(error.message));
});

test("central directory listing stops at the entry limit", () => {
  const parts = Object.fromEntries(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) =>
    [`part${index}.xml`, utf8("")]));
  const archive = buildZip(parts);

  assert.throws(() => listEntries(archive), (error: unknown) =>
    error instanceof ZipError && /more than .* entries/.test(error.message));
});

test("a declared expansion past the budget is refused", () => {
  assert.throws(
    () =>
      checkBudget([
        { name: "bomb.bin", compressedSize: MAX_EXPANDED_BYTES + 1, originalSize: MAX_EXPANDED_BYTES + 1 },
      ]),
    (error: unknown) => error instanceof ZipError && /expands to/.test(error.message),
  );
  // Summed, not per entry: a thousand entries just under the limit each is the
  // same attack spelled differently.
  assert.throws(
    () =>
      checkBudget(
        Array.from({ length: 200 }, (_, index) => ({
          name: `part${index}`,
          compressedSize: MAX_EXPANDED_BYTES / 100,
          originalSize: MAX_EXPANDED_BYTES / 100,
        })),
      ),
    ZipError,
  );
});

test("one oversized entry is refused independently of the archive total", () => {
  assert.throws(
    () =>
      checkBudget([
        { name: "huge.xml", compressedSize: MAX_ZIP_ENTRY_BYTES + 1, originalSize: MAX_ZIP_ENTRY_BYTES + 1 },
      ]),
    /per-entry limit/,
  );
});

test("an extreme compression ratio is refused before inflation", () => {
  assert.throws(
    () =>
      checkBudget([
        { name: "bomb.xml", compressedSize: 1, originalSize: MAX_COMPRESSION_RATIO + 1 },
      ]),
    /compression-ratio limit/,
  );
});

test("an entry named like a path escape is refused", () => {
  for (const name of ["../etc/passwd", "/etc/passwd", "a/../../b"]) {
    assert.throws(
      () => checkBudget([{ name, compressedSize: 1, originalSize: 1 }]),
      ZipError,
      `expected ${JSON.stringify(name)} to be refused`,
    );
  }
  // A dot in a name is not an escape: `docProps/app.xml` is ordinary.
  checkBudget([{ name: "docProps/app.xml", compressedSize: 1, originalSize: 1 }]);
});

test("openZip checks before it hands out a reader", () => {
  const archive = openZip(buildZip({ "a.xml": utf8("<a/>") }));
  assert.equal(archive.entries.length, 1);
  assert.equal(new TextDecoder().decode(archive.read(["a.xml"]).get("a.xml")), "<a/>");
});
