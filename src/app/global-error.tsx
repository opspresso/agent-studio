"use client";

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

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#fff",
          color: "#1a1b1e",
        }}
      >
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Agent Studio could not start</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#6c757d", margin: "0 0 16px" }}>
            Something failed before the console could render. Reloading usually clears it; if it
            does not, the digest below identifies the failure in the server log.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, fontFamily: "monospace", color: "#6c757d" }}>
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
              border: "1px solid #ced4da",
              background: "#f8f9fa",
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
