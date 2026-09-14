import { receiveWorkspaceGitHubWebhook, verifyWorkspaceGitHubWebhook } from "@/lib/container";
import { readEventBody } from "@/app/api/_lib/inboundEvent";
import { apiError } from "@/app/api/_lib/http";
import { unauthorized } from "@/shared/unauthorized";

export interface WorkspaceWebhookResponse { processed: boolean }

export async function POST(request: Request): Promise<Response> {
  try {
    const raw = await readEventBody(request);
    if (raw instanceof Response) return raw;
    if (!verifyWorkspaceGitHubWebhook(raw, request.headers.get("x-hub-signature-256"))) return unauthorized();
    const result = await receiveWorkspaceGitHubWebhook(request.headers.get("x-github-delivery") ?? "", raw);
    return Response.json(result satisfies WorkspaceWebhookResponse);
  } catch (error) { return apiError(error); }
}
