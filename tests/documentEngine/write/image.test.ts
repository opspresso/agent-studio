/**
 * The two header walks, checked against hand-built fixtures.
 *
 * Real images are big and binary; the parsers only ever read the header, so
 * the fixtures are headers — a PNG's fixed IHDR offsets, a JPEG's marker walk
 * past an APP0 to the start-of-frame.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { fitInto, imageSize, pdfPngSize } from "@/infrastructure/documents/engine/write/image";

/** 640×400, as the eight signature bytes + IHDR demand. */
function pngFixture(width = 640, height = 400): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** 640×400 behind an APP0 segment, which is where real files put one. */
function jpegFixture(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    // APP0, 4 bytes of payload the walk must skip.
    0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46,
    // SOF0: precision 8, height 400, width 640.
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

test("a PNG's size comes from its IHDR, a JPEG's from its start-of-frame", () => {
  assert.deepEqual(imageSize(pngFixture(), "image/png"), { width: 640, height: 400 });
  assert.deepEqual(imageSize(jpegFixture(), "image/jpeg"), { width: 640, height: 400 });
});

test("bytes that are not the format they claim are refused with the reason", () => {
  assert.throws(() => imageSize(jpegFixture(), "image/png"), /not a readable PNG/);
  assert.throws(() => imageSize(pngFixture(), "image/jpeg"), /not a readable JPEG/);
  assert.throws(() => imageSize(new Uint8Array(4), "image/png"), /not a readable PNG/);
  const wrongChunk = pngFixture();
  wrongChunk.set([0x61, 0x62, 0x63, 0x64], 12);
  assert.throws(() => imageSize(wrongChunk, "image/png"), /not a readable PNG/);
  const wrongLength = pngFixture();
  new DataView(wrongLength.buffer).setUint32(8, 12);
  assert.throws(() => imageSize(wrongLength, "image/png"), /not a readable PNG/);
});

test("a picture scales down to fit and never up past its pixels", () => {
  const box = { x: 0, y: 0, width: 9525 * 320, height: 9525 * 400 };
  // Wider than the box: scaled to the box's width, centred vertically.
  const wide = fitInto({ width: 640, height: 400 }, box);
  assert.equal(wide.width, box.width);
  assert.equal(wide.height, Math.round(box.width * (400 / 640)));
  assert.ok(wide.y > box.y, "centred, so pushed down from the top");
  // Smaller than the box: kept at its natural 96dpi size.
  const small = fitInto({ width: 100, height: 50 }, box);
  assert.equal(small.width, 9525 * 100);
  assert.equal(small.height, 9525 * 50);
});


test("PDF PNG preflight refuses animated, duplicate and invalid allocation headers", () => {
  const header = Buffer.from(pngFixture());
  header[24] = 8;
  header[25] = 6;
  const end = Buffer.alloc(12);
  end.write("IEND", 4);
  const png = Buffer.concat([header, end]);
  assert.deepEqual(pdfPngSize(png), { width: 640, height: 400 });
  assert.throws(() => pdfPngSize(Buffer.concat([header, header.subarray(8), end])), /exactly one/);
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0);
  animation.write("acTL", 4);
  animation.writeUInt32BE(2, 8);
  assert.throws(() => pdfPngSize(Buffer.concat([header, animation, end])), /animated PNG/);
  const invalid = Buffer.from(png);
  invalid[24] = 255;
  assert.throws(() => pdfPngSize(invalid), /IHDR parameters/);
  assert.throws(() => pdfPngSize(png.subarray(0, png.length - 1)), /IEND/);
});
