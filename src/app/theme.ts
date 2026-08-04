"use client";

import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * The app's single styling decision point.
 *
 * Before Mantine this was three files pretending to be one — `buttonStyles.ts`,
 * `formStyles.ts`, and thirty-odd inline copies that had already drifted apart
 * (buttons with no `disabled:` style, inputs with no focus ring, a badge that
 * lost its dark-mode colour). Anything that used to be a shared class constant
 * belongs in `components.defaultProps` below: a default set here reaches every
 * call site, which is the property those constants were reaching for.
 */

/**
 * The brand ramp, anchored on the two colours the old Tailwind theme defined:
 * shade 6 is `--color-brand` (oklch(0.59 0.2 259)) and shade 7 is
 * `--color-brand-strong` (oklch(0.51 0.22 263)), which was the hover colour.
 * The rest is that hue stepped through OKLCH and clamped into sRGB, so the
 * lighter shades stay on-hue instead of clipping to pure blue.
 */
const brand: MantineColorsTuple = [
  "#eff5ff",
  "#deebfe",
  "#c0d8fe",
  "#9ec3fd",
  "#7aacfd",
  "#5292fc",
  "#2477f1",
  "#1856e1",
  "#1348c0",
  "#0f3ca0",
];

export const theme = createTheme({
  primaryColor: "brand",
  // Light keeps the old brand colour exactly. Dark takes the next step down so
  // white-on-brand stays legible against a dark surface, which shade 6 does not.
  primaryShade: { light: 6, dark: 7 },
  colors: { brand },
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  defaultRadius: "lg",
  focusRing: "auto",
  headings: {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontWeight: "650",
  },
  components: {
    // The old `buttonClass()` default was `md` = px-3 py-2 text-sm, which is
    // Mantine's `sm`. Setting it here rather than on 43 call sites is the whole
    // point of the migration.
    Button: { defaultProps: { size: "sm" } },
    ActionIcon: { defaultProps: { variant: "subtle", color: "gray" } },
    // `cardClass`: rounded-lg border bg-white p-4.
    Card: { defaultProps: { withBorder: true, radius: "lg", padding: "lg" } },
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
