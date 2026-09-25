import { tierMayCreateAgents } from "@/domain/member/tiers";
import { withAuth } from "@/lib/session";
import { createAgent, agentUseCases } from "@/lib/container";
import { createAgentSchema } from "@/app/api/agents/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeAgent } from "@/app/api/agents/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

export const GET = withAuth(async (user) => {
  // One argument on purpose: `map` would otherwise pass the index where
  // sanitizeAgent now takes its options.
  return Response.json(
    (await agentUseCases.listAccessible(user.email)).map((agent) => sanitizeAgent(agent)),
  );
});

export const POST = withAuth(async (user, request: Request) => {
  // Agent creation is a tier capability. An admin-list entry grants access
  // to administration, but does not widen the stored tier's spend surface.
  // The same predicate hides the console's "New agent" button; this 403 is
  // the backstop, not the UX.
  if (!tierMayCreateAgents(user.tier)) {
    return Response.json({ error: "Your tier does not allow creating agents" }, { status: 403 });
  }
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    // Agent metadata and initial Agent settings are created atomically.
    const agent = await createAgent({
      ...parsed.data,
      ownerEmail: user.email,
    });
    return Response.json(sanitizeAgent(agent), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
