"use client";

import { signIn, signOut, useSession } from "@/lib/auth-client";

export function UserMenu() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <div className="h-8 w-8 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800" />;
  }

  if (!session) {
    return (
      <button
        type="button"
        onClick={() => signIn.social({ provider: "google" })}
        className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong"
      >
        Sign in with Google
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-neutral-600 dark:text-neutral-300">{session.user.email}</span>
      <button
        type="button"
        onClick={() => signOut()}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        Sign out
      </button>
    </div>
  );
}
