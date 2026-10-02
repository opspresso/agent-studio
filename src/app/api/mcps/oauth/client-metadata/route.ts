import { clientMetadataDocument } from "@/application/mcp/mcpAuthUseCases";
import { getPublicBaseUrl, getServiceBranding } from "@/lib/runtime-settings";

/** Public installation metadata is read by OAuth servers; PKCE and session-bound state protect grants. */
export async function GET(): Promise<Response> {
  const base = await getPublicBaseUrl();
  if (!base) return new Response("A public base URL is not configured", { status: 503 });
  return Response.json(clientMetadataDocument(base, (await getServiceBranding()).name), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
