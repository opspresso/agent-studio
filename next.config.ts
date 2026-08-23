import type { NextConfig } from "next";

/**
 * Response headers the console is served with.
 *
 * Deliberately not a Content-Security-Policy yet: Mantine and Next both emit
 * inline styles, so a useful policy needs a nonce pipeline and a wrong one
 * breaks the page silently. These three need none of that and each answers
 * something real — the console has buttons that delete an artifact and rotate a
 * key, and until now any page could put it in an iframe and collect the click.
 */
const SECURITY_HEADERS = [
  // The modern spelling and the one older browsers read. `DENY` rather than
  // `SAMEORIGIN`: nothing here frames anything of its own.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  // The one page served as text/html from a route handler puts an
  // authorization server's words on it. Sniffing is one way a wrong guess about
  // a response's type becomes a script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // A URL is often itself the credential here — a signed S3 address, a webhook
  // path — and a full referrer hands it to whatever the reader clicks next.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // `next dev` run from an AI coding agent otherwise appends its own
  // "read node_modules/next/dist/docs" block to AGENTS.md on every start;
  // this repository's agent rules are written by hand.
  agentRules: false,
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@swc/helpers/esm/**/*"],
  },
  experimental: {
    optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"],
    useTypeScriptCli: true,
  },
  /**
   * These are the *console's* headers, and one route is not the console.
   *
   * A header declared here **replaces** what a route handler set under the same
   * key, so `/api/artifacts/:id/view` — the one response that is deliberately
   * served under a `sandbox` policy — came back carrying `frame-ancestors
   * 'none'` instead, and an artifact's markup ran on this origin with the
   * console's cookies and storage in reach. The whole reason that route answers
   * with bytes rather than a signed object URL is a header it turned out not to
   * be sending.
   *
   * The exclusion is written as a negative lookahead rather than by narrowing
   * the console rule, so a page added tomorrow is covered by default and only
   * the addresses that set their own policy are left alone. `/api/objects/`
   * is the second: in proxied access mode it answers with a stored object's
   * bytes on this origin, and carries the same sandbox for the same reason.
   */
  async headers() {
    return [
      {
        source: "/((?!api/artifacts/[^/]+/view$|api/objects/).*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
