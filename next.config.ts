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
  experimental: {
    optimizePackageImports: ["@mantine/core", "@mantine/hooks", "@tabler/icons-react"],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
