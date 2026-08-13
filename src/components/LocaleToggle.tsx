"use client";

/**
 * The language picker, beside the colour-scheme one in the header.
 *
 * Writing the cookie from the browser and calling `router.refresh()` is the
 * whole mechanism: the refresh re-runs the server tree, the root layout reads
 * the new cookie, and every string re-renders in place. Client state survives
 * it — a half-filled form stays filled — which a full navigation would not
 * give, and there is no locale in the URL to keep in step because the choice
 * was deliberately kept out of the route (`_i18n/locale.ts` says why).
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Menu, ActionIcon } from "@mantine/core";
import { IconLanguage } from "@tabler/icons-react";
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
          <IconLanguage size={18} stroke={1.8} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {LOCALES.map((value) => (
          <Menu.Item
            key={value}
            onClick={() => choose(value)}
            data-active={value === locale || undefined}
          >
            {LOCALE_LABELS[value]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
