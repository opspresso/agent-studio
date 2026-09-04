"use client";

import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * The app's single styling decision point.
 *
 * Every styling default belongs in `components.defaultProps` below, because a
 * default set here reaches every call site. The alternative is what this
 * replaced: shared class constants beside thirty-odd inline copies that had
 * drifted apart — buttons with no `disabled:` style, inputs with no focus ring,
 * a badge that had lost its dark-mode colour.
 */

/**
 * The brand ramp: indigo-violet, at OKLCH hue 290.
 *
 * Every shade shares the measured hue while preserving the ramp's lightness and
 * chroma. That matters because the shades are load-bearing beyond the accent: shade 6 is the
 * light-mode primary and shade 7 the dark one, both chosen for white-on-brand
 * contrast, and shifting L would have quietly broken that.
 *
 * 290 is not a taste call. It is the measured hue of the accent this palette is
 * modelled on (#6e43dc → #8051f9, both hue 289.5), and shade 7 lands on #6b3dd8
 * as a result — the same colour, arrived at from our own lightness curve.
 *
 * Clamping into sRGB walks chroma down at fixed hue rather than clipping each
 * channel, which is what keeps the light shades on-hue instead of drifting.
 */
const brand: MantineColorsTuple = [
  "#f4f3fe",
  "#e9e7fd",
  "#d5d1fb",
  "#c0b8f9",
  "#ab9df8",
  "#957ef5",
  "#805fe9",
  "#6b3dd8",
  "#5b33b8",
  "#4b2a99",
];

export const theme = createTheme({
  primaryColor: "brand",
  // Light keeps the old brand colour exactly. Dark takes the next step down so
  // white-on-brand stays legible against a dark surface, which shade 6 does not.
  primaryShade: { light: 6, dark: 7 },
  colors: { brand },
  /*
   * The faces are loaded in `layout.tsx` and reach us as CSS variables, never as
   * imports — this file is a client module and cannot hold a `next/font` object.
   *
   * The system stack stays behind each one and is doing real work, not sitting
   * there as boilerplate: neither Figtree nor Chakra Petch ships Hangul, so it
   * is what actually renders Korean.
   */
  fontFamily:
    'var(--font-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    'var(--font-mono), ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  // Mantine's own `xl` is 32px, which reads as a pill on a dense settings card.
  // 20px is the step above `lg` that the surfaces here actually want.
  radius: { xl: "20px" },
  defaultRadius: "lg",
  focusRing: "auto",
  headings: {
    // Chakra Petch is squared-off and wide; it carries a heading and nothing
    // else, so `--font-sans` follows it for any glyph it lacks.
    fontFamily:
      'var(--font-display), var(--font-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    // 600 rather than the old 650: this face has real weights instead of a
    // variable axis, so an in-between value would round to one of them anyway.
    fontWeight: "600",
  },
  components: {
    // The old `buttonClass()` default was `md` = px-3 py-2 text-sm, which is
    // Mantine's `sm`. Setting it here rather than on 43 call sites is the whole
    // point of the migration.
    Button: { defaultProps: { size: "sm" } },
    ActionIcon: { defaultProps: { variant: "subtle", color: "gray" } },
    // The border is a hairline: a card is told apart by its shadow, and the
    // border only has to stop it bleeding into the surface behind it.
    Card: { defaultProps: { withBorder: true, radius: "xl", padding: "lg" } },
    Paper: { defaultProps: { radius: "lg" } },
    // The old `Badge` was neutral; brand-coloured ones passed their own colour.
    Badge: { defaultProps: { variant: "light", color: "gray", radius: "sm" } },
    TextInput: { defaultProps: { size: "sm" } },
    Textarea: { defaultProps: { size: "sm" } },
    NumberInput: { defaultProps: { size: "sm" } },
    PasswordInput: { defaultProps: { size: "sm" } },
    Select: { defaultProps: { size: "sm" } },
    MultiSelect: { defaultProps: { size: "sm" } },
    Autocomplete: { defaultProps: { size: "sm" } },
    Checkbox: { defaultProps: { size: "sm" } },
    Switch: { defaultProps: { size: "sm" } },
    Modal: { defaultProps: { radius: "md", centered: false } },
    Tooltip: { defaultProps: { withArrow: true, fz: "xs" } },
  },
});
