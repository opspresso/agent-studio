import type { NextConfig } from "next";

/**
 * Console headers prevent framing, MIME sniffing and cross-origin path leaks.
 * CSP currently restricts framing only. Script/style restrictions require a
 * nonce pipeline compatible with Next.js and Mantine's inline output.
 */
const SECURITY_HEADERS = [
  // Console pages cannot be framed, including by another same-origin page.
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Signed URLs and webhook paths must not appear in cross-origin referrers.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  // Next allows localhost by default and matches additional origins by hostname.
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  output: "standalone",
  // `next dev` run from an AI coding agent otherwise appends its own
  // "read node_modules/next/dist/docs" block to AGENTS.md on every start;
  // this repository's agent rules are written by hand.
  agentRules: false,
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@swc/helpers/**/*", "./assets/document-fonts/**/*", "./build/document-worker.cjs", "./build/audio-worker.cjs"],
  },
  experimental: {
    optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"],
    useTypeScriptCli: true,
  },
  /**
   * Next.js config headers replace same-named route headers. Artifact views
   * and proxied objects own their sandbox CSP, so exclude them from this rule.
   * The negative lookahead keeps newly added console pages covered by default.
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
