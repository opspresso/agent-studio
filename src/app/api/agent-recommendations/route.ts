import { z } from "zod";
import { agentRecommendationUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { MAX_AGENT_RECOMMENDATION_REQUEST_LENGTH } from "@/application/llm/agentRecommendation";
import { tierAtLeast } from "@/domain/member/tiers";

const schema = z.object({
  surface: z.enum(["chat", "workspace"]),
  request: z.string().trim().min(1).max(MAX_AGENT_RECOMMENDATION_REQUEST_LENGTH),
});

export interface AgentRecommendationResponse {
  recommendation: { name: string; confidence: number } | null;
}

export const POST = withAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  if (parsed.data.surface === "workspace" && !tierAtLeast(user.tier, "member")) {
    return Response.json({ error: "This resource is not available to your account" }, { status: 403 });
  }
  try {
    return Response.json({
      recommendation: await agentRecommendationUseCases.recommend(parsed.data.surface, user.email, parsed.data.request, request.signal),
    } satisfies AgentRecommendationResponse);
  } catch (error) { return apiError(error, request); }
});
