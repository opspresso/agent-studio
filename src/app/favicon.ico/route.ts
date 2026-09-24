import { getServiceBranding } from "@/lib/runtime-settings";

export const dynamic = "force-dynamic";

/** Conventional favicon requests follow the selected brand without caching the choice. */
export async function GET(): Promise<Response> {
  return new Response(null, {
    status: 307,
    headers: {
      Location: (await getServiceBranding()).faviconUrl,
      "Cache-Control": "no-store",
    },
  });
}
