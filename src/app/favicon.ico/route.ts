import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Conventional favicon requests follow the selected brand without caching the choice. */
export function GET(): Response {
  return new Response(null, {
    status: 307,
    headers: {
      Location: config.branding.faviconUrl,
      "Cache-Control": "no-store",
    },
  });
}
