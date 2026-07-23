import { getSlackSigningSecret } from "@/lib/runtime-settings";
import { handleSlackEventRequest } from "./_lib/handleEventRequest";

/** Workspace-default bot Slack Events endpoint. */
export async function POST(request: Request): Promise<Response> {
  const signingSecret = await getSlackSigningSecret();
  if (!signingSecret) {
    return Response.json({ error: "Slack is not configured" }, { status: 503 });
  }
  return handleSlackEventRequest(request, { signingSecret, logLabel: "default" });
}
