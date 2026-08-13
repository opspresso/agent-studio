"use client";

import { useState } from "react";
import { Button } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { signIn } from "@/lib/auth-client";

export function SignInButton({
  label,
  compact = false,
  callbackURL = "/",
}: {
  /** Overrides the default wording; falls back to the translated label. */
  label?: string;
  compact?: boolean;
  /**
   * Where Google returns the user. `/login` passes the page they were turned
   * away from, so the round trip ends where it started; it has already been
   * through `safeNextPath`, and Better Auth only accepts same-origin values.
   */
  callbackURL?: string;
}) {
  const [pending, setPending] = useState(false);
  const t = useT();

  async function handleSignIn() {
    setPending(true);
    try {
      await signIn.social({ provider: "google", callbackURL });
    } catch {
      setPending(false);
    }
  }

  return (
    <Button
      onClick={() => void handleSignIn()}
      loading={pending}
      size={compact ? "xs" : "md"}
    >
      {label ?? t("auth.signIn")}
    </Button>
  );
}
