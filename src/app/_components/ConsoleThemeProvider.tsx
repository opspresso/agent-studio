"use client";

import { useMemo } from "react";
import { MantineProvider } from "@mantine/core";
import { theme } from "@/app/theme";
import { useT } from "@/app/_i18n/provider";

/** Library-generated close controls inherit the console locale; explicit action labels still win. */
export function ConsoleThemeProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const localizedTheme = useMemo(() => ({ ...theme, components: {
    ...theme.components,
    CloseButton: { defaultProps: { "aria-label": t("common.close") } },
  } }), [t]);
  return <MantineProvider theme={localizedTheme} defaultColorScheme="auto">{children}</MantineProvider>;
}
