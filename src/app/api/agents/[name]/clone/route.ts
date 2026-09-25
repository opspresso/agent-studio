import { tierMayCreateAgents } from "@/domain/member/tiers";
import { withAuth } from "@/lib/session";
import { cloneAgent } from "@/lib/container";
import { cloneAgentSchema } from "@/app/api/agents/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeAgent } from "@/app/api/agents/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

export interface CloneAgentResponse {
  agent: ReturnType<typeof sanitizeAgent>;
  /** What the clone could not carry — absent when everything copied. */
  warning?: string;
}

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  // The same tier gate as creating an agent: a clone is one.
  if (!tierMayCreateAgents(user.tier)) {
    return Response.json({ error: "Your tier does not allow creating agents" }, { status: 403 });
  }
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = cloneAgentSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const { agent, warning } = await cloneAgent({
      sourceName: name,
      name: parsed.data.name,
      displayName: parsed.data.displayName,
      userEmail: user.email,
    });
    return Response.json(
      {
        agent: sanitizeAgent(agent),
        ...(warning ? { warning } : {}),
      } satisfies CloneAgentResponse,
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
});
