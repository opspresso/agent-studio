"use client";

import { useEffect, useState } from "react";
import { Menu, ActionIcon, useMantineColorScheme, type MantineColorScheme } from "@mantine/core";
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
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
   * The stored preference exists only in the browser, so the server always
   * renders the default ("auto") while the client renders whatever is in
   * localStorage — a hydration mismatch that React resolves by throwing the
   * tree away and rebuilding it. Showing the default until mount makes both
   * first renders agree; the real preference lands one paint later.
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
        {OPTIONS.map(({ value, label, Icon }) => (
          <Menu.Item
            key={value}
            leftSection={<Icon size={16} stroke={1.8} />}
            onClick={() => setColorScheme(value)}
            data-active={colorScheme === value || undefined}
          >
            {t(label)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
