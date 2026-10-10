"use client";

/**
 * The language picker, beside the colour-scheme one in the header.
 *
 * Write the locale cookie and refresh the server tree. The root supplies the
 * new locale while client drafts survive; language does not change the URL.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Menu, ActionIcon } from "@mantine/core";
import { IconCheck, IconWorld } from "@tabler/icons-react";
import {
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_LABELS,
  type Locale,
} from "@/app/_i18n/locale";
import { useLocale, useT } from "@/app/_i18n/provider";

export function LocaleToggle() {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();
  const [pending, startTransition] = useTransition();

  function choose(next: Locale) {
    if (next === locale) {
      return;
    }
    // `secure` only where it can be honoured: dev runs on plain http, and a
    // cookie the browser refuses is a toggle that silently does nothing.
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie =
      `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${secure}`;
    startTransition(() => router.refresh());
  }

  return (
    <Menu position="bottom-end" width={140} withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="default"
          size="lg"
          aria-label={t("locale.change")}
          title={t("locale.label")}
          loading={pending}
        >
          <IconWorld size={18} stroke={1.8} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.RadioGroup value={locale} onChange={value => choose(value as Locale)}>
          {LOCALES.map(value => <Menu.RadioItem key={value} value={value} closeMenuOnClick
            checkIcon={<IconCheck size={14} aria-hidden="true" />}>
            {LOCALE_LABELS[value]}
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Dropdown>
    </Menu>
  );
}
