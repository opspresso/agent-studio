"use client";

import { useEffect } from "react";

/**
 * The last resort: a throw in the root layout itself.
 *
 * This one replaces the layout rather than rendering inside it, so there is no
 * Mantine provider, no locale and no shell to borrow from — it has to render
 * its own `<html>` and `<body>` and style itself inline. That is also why the
 * copy here is English and not in the catalogue: `useT` needs the provider this
 * file exists because of.
 *
 * `app/error.tsx` is what a reader will normally see. Everything that reaches
 * here failed before the console existed, so the only useful action is a fresh
 * load.
 */

const PALETTE = `
  :root {
    color-scheme: light dark;
    --bg: #fff;
    --fg: #1a1b1e;
    --muted: #6c757d;
    --surface: #f8f9fa;
    --border: #ced4da;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1b1e;
      --fg: #f1f3f5;
      --muted: #909296;
      --surface: #25262b;
      --border: #373a40;
    }
  }
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Same reason as `ErrorCard`: a client-side throw leaves no server log line,
  // and this boundary catches the ones with the least else to go on.
  useEffect(() => {
    console.error("[console] root layout failed", error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        {/*
         * The palette is inline because this file replaces the layout that
         * would otherwise supply one — and it answers to the system scheme,
         * because the least expected failure in the console should not also
         * be a full-viewport white flash for a reader in dark mode.
         */}
        <style>{PALETTE}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "var(--bg)",
          color: "var(--fg)",
        }}
      >
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Agent Studio could not start</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--muted)", margin: "0 0 16px" }}>
            Something failed before the console could render. Reloading usually clears it; if it
            does not, the digest below identifies the failure in the server log.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, fontFamily: "monospace", color: "var(--muted)" }}>
              {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 8,
              padding: "8px 16px",
              fontSize: 14,
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--fg)",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
