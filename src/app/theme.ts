"use client";

import { createTheme, type MantineColorsTuple } from "@mantine/core";

/** Brand palette and component defaults shared by every console surface. */
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
  primaryShade: { light: 7, dark: 7 },
  colors: {
    brand,
    gray: [
      "#f6f7f9",
      "#f0f2f5",
      "#e7eaf0",
      "#dce0e7",
      "#bfc6d1",
      "#99a2b1",
      "#687486",
      "#465366",
      "#303d50",
      "#202b3b",
    ],
    dark: [
      "#eef0f4",
      "#d4d9e2",
      "#aab2c0",
      "#535c6d",
      "#363c48",
      "#2d323d",
      "#252932",
      "#1c1f26",
      "#14161b",
      "#101217",
    ],
  },
  fontFamily:
    'var(--font-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    'var(--font-mono), ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  radius: { md: "8px", lg: "12px", xl: "16px" },
  defaultRadius: "md",
  focusRing: "auto",
  headings: {
    fontFamily:
      'var(--font-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontWeight: "600",
  },
  components: {
    Button: { defaultProps: { size: "sm" } },
    ActionIcon: { defaultProps: { variant: "subtle", color: "gray", size: "lg" } },
    Card: { defaultProps: { withBorder: true, radius: "lg", padding: "lg" } },
    Paper: { defaultProps: { radius: "lg" } },
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
