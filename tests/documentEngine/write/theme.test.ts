/**
 * The palette, checked for the one property a colour choice can actually fail.
 *
 * Everything else about a design system is taste and cannot be asserted. Contrast
 * is not: text below the WCAG AA ratio is text somebody cannot read, and a
 * palette is exactly the kind of thing that gets nudged one shade "for looks"
 * without anybody re-measuring. These tests are what makes that nudge fail
 * loudly rather than ship.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  CHART,
  DEFAULT_PROFILE,
  DOCUMENT_PROFILES,
  LEADING,
  PALETTE,
  TYPOGRAPHY,
  centiPoints,
  designFor,
  emu,
  halfPoints,
  hashed,
  rgbOf,
  twips,
} from "@/infrastructure/documents/engine/write/theme";

/** WCAG's relative luminance, which is not the same as perceived lightness. */
function luminance(hex: string): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(0, 2), 16));
  const g = channel(parseInt(hex.slice(2, 4), 16));
  const b = channel(parseInt(hex.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** Body text and anything small. */
const AA = 4.5;
/** 18pt and up, or 14pt bold — which every heading in both scales is. */
const AA_LARGE = 3;

test("body text clears AA on every ground it is set on", () => {
  const grounds = ["onBrand", "brandTint", "surfaceTint"] as const;
  for (const ground of grounds) {
    const ratio = contrast(PALETTE.ink, PALETTE[ground]);
    assert.ok(ratio >= AA, `ink on ${ground} is ${ratio.toFixed(2)}:1, under ${AA}:1`);
  }
});

test("muted text and links clear AA on white", () => {
  for (const name of ["inkMuted", "brandDeep"] as const) {
    const ratio = contrast(PALETTE[name], PALETTE.onBrand);
    assert.ok(ratio >= AA, `${name} on white is ${ratio.toFixed(2)}:1, under ${AA}:1`);
  }
});

test("white on the brand fill clears AA, which is what a table header needs", () => {
  // The header is the one place this palette puts small text on a saturated
  // ground. Shade 7 rather than 6 is what buys the ratio.
  const ratio = contrast(PALETTE.onBrand, PALETTE.brand);
  assert.ok(ratio >= AA, `white on brand is ${ratio.toFixed(2)}:1, under ${AA}:1`);
});

test("headings clear the large-text threshold on white", () => {
  const ratio = contrast(PALETTE.brand, PALETTE.onBrand);
  assert.ok(ratio >= AA_LARGE, `brand on white is ${ratio.toFixed(2)}:1, under ${AA_LARGE}:1`);
});

test("every categorical chart colour is distinguishable from the page", () => {
  // Not a text ratio — a fill only has to be visible. 1.5:1 is the floor below
  // which a swatch disappears into white on a projector.
  for (const colour of CHART) {
    const ratio = contrast(colour, PALETTE.onBrand);
    assert.ok(ratio >= 1.5, `chart colour ${colour} is ${ratio.toFixed(2)}:1 against white`);
  }
});

test("the five document profiles are explicit and executive is the default", () => {
  assert.deepEqual(DOCUMENT_PROFILES, ["executive", "consulting", "formal", "technical", "standard"]);
  assert.equal(DEFAULT_PROFILE, "executive");
  assert.equal(PALETTE, designFor(DEFAULT_PROFILE).palette);
});

test("every profile keeps its text legible and carries a distinct visual system", () => {
  const brands = new Set<string>();
  for (const profile of DOCUMENT_PROFILES) {
    const design = designFor(profile);
    brands.add(design.palette.brand);
    assert.ok(contrast(design.palette.onBrand, design.palette.brand) >= AA);
    assert.ok(contrast(design.table.headerText, design.table.headerFill) >= AA);
    assert.ok(contrast(design.palette.ink, design.palette.surfaceTint) >= AA);
    assert.ok(design.deck.coverBandPoints >= 0 && design.deck.coverBandPoints <= 36);
    assert.ok(design.doc.coverRulePoints >= 36 && design.doc.coverRulePoints <= 72);
  }
  assert.equal(brands.size, DOCUMENT_PROFILES.length);
});

test("formal and technical profiles use restrained light table headers", () => {
  for (const profile of ["formal", "technical"] as const) {
    const design = designFor(profile);
    assert.equal(design.table.headerFill, design.palette.brandTint);
    assert.equal(design.table.headerText, design.palette.brand);
  }
});

test("typography keeps prose readable and display lines compact", () => {
  assert.deepEqual(LEADING.document, {
    body: 1.5,
    heading: 1.2,
    coverTitle: 1.15,
    subtitle: 1.4,
    compact: 1.35,
  });
  assert.deepEqual(LEADING.deck, {
    body: 1.35,
    title: 1.15,
    coverTitle: 1.1,
    subtitle: 1.3,
  });
  assert.equal(TYPOGRAPHY.tracking, 0);
  assert.equal(TYPOGRAPHY.kerningFromPoints, 12);
});

test("a colour is one value, whatever form it is asked for", () => {
  assert.equal(hashed("brand"), `#${PALETTE.brand}`);
  const { r, g, b } = rgbOf("onBrand");
  assert.deepEqual([r, g, b], [1, 1, 1]);
  assert.deepEqual(rgbOf("ink"), {
    r: parseInt(PALETTE.ink.slice(0, 2), 16) / 255,
    g: parseInt(PALETTE.ink.slice(2, 4), 16) / 255,
    b: parseInt(PALETTE.ink.slice(4, 6), 16) / 255,
  });
});

test("the converters agree with the units their formats count in", () => {
  // 11pt is 22 half-points, 220 twentieths, 1100 hundredths, and 139,700 EMU.
  assert.equal(halfPoints(11), 22);
  assert.equal(twips(11), 220);
  assert.equal(centiPoints(11), 1100);
  assert.equal(emu(11), 139_700);
});
