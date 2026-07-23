"use client";

import { useState } from "react";
import { signIn } from "@/lib/auth-client";

export function SignInButton({
  label = "Sign in with Google",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);

  async function handleSignIn() {
    setPending(true);
    try {
      await signIn.social({ provider: "google", callbackURL: "/" });
    } catch {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleSignIn()}
      disabled={pending}
      aria-busy={pending}
      className={`rounded-md bg-brand text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:opacity-70 ${
        compact ? "px-3 py-1.5" : "px-5 py-2.5"
      }`}
    >
      {pending ? "Signing in…" : label}
    </button>
  );
}
