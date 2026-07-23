"use client";

import { useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { SignInButton } from "./SignInButton";

export function UserMenu() {
  const { data: session, isPending } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      window.location.assign("/");
    } catch {
      setSigningOut(false);
    }
  }

  if (isPending) {
    return <div className="h-8 w-8 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800" />;
  }

  if (!session) {
    return <SignInButton compact />;
  }

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <span className="hidden max-w-52 truncate text-sm text-neutral-600 lg:inline dark:text-neutral-300">
        {session.user.email}
      </span>
      <button
        type="button"
        onClick={() => void handleSignOut()}
        disabled={signingOut}
        aria-busy={signingOut}
        className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm hover:bg-neutral-100 disabled:cursor-wait disabled:opacity-60 sm:px-3 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
