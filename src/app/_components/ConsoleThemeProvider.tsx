"use client";

import { useMemo } from "react";
import { MantineProvider, type PaginationProps } from "@mantine/core";
import { consoleCssVariables, theme } from "@/app/theme";
import { useT } from "@/app/_i18n/provider";

/** Library-generated close and pagination controls inherit localized names; explicit labels still win. */
export function ConsoleThemeProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const localizedTheme = useMemo(() => {
    const pagination = {
      role: "group",
      "aria-label": t("pagination.label"),
      getControlProps: control => ({ "aria-label": t(`pagination.${control}`) }),
      getItemProps: page => ({ "aria-label": t("pagination.page", { page }) }),
    } satisfies Partial<PaginationProps>;
    return { ...theme, components: {
      ...theme.components,
      CloseButton: { defaultProps: { "aria-label": t("common.close") } },
      Pagination: { defaultProps: pagination },
    } };
  }, [t]);
  return <MantineProvider theme={localizedTheme} cssVariablesResolver={consoleCssVariables} defaultColorScheme="auto">{children}</MantineProvider>;
}
