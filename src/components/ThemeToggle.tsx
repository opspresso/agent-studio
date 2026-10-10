"use client";

import { useEffect, useState } from "react";
import { Menu, ActionIcon, useMantineColorScheme, type MantineColorScheme } from "@mantine/core";
import { IconCheck, IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useT } from "@/app/_i18n/provider";

/**
 * Colour scheme picker. The scheme itself, its persistence, and the
 * before-paint application all belong to Mantine (`ColorSchemeScript` in the
 * root layout); this is only the control.
 */

const OPTIONS = [
  { value: "auto", label: "theme.system", Icon: IconDeviceDesktop },
  { value: "light", label: "theme.light", Icon: IconSun },
  { value: "dark", label: "theme.dark", Icon: IconMoon },
] as const satisfies ReadonlyArray<{
  value: MantineColorScheme;
  label: MessageKey;
  Icon: typeof IconSun;
}>;

export function ThemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const t = useT();

  /**
   * Show the default icon until mount to match SSR; then read the browser's
   * stored preference. Mantine already applies the actual page scheme before paint.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current =
    (mounted ? OPTIONS.find((option) => option.value === colorScheme) : undefined) ?? OPTIONS[0];
  const CurrentIcon = current.Icon;

  return (
    <Menu position="bottom-end" width={140} withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="default"
          size="lg"
          aria-label={t("theme.current", { name: t(current.label) })}
          title={t(current.label)}
        >
          <CurrentIcon size={18} stroke={1.8} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.RadioGroup value={colorScheme} onChange={value => setColorScheme(value as MantineColorScheme)}>
          {OPTIONS.map(({ value, label, Icon }) => <Menu.RadioItem key={value} value={value} closeMenuOnClick
            checkIcon={<IconCheck size={14} aria-hidden="true" />}
            rightSection={<Icon size={16} stroke={1.8} aria-hidden="true" />}>
            {t(label)}
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Dropdown>
    </Menu>
  );
}
