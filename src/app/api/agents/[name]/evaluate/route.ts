import { z } from "zod";
import { agentUseCases, evaluationUseCases } from "@/lib/container";
import { requireAgentConfiguration } from "@/application/agent/configurationUseCases";
import { authenticateExecution, principalRunContext } from "@/app/api/agents/_lib/executionAuth";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { MAX_EVALUATION_TOKEN_CHARS, MAX_EVALUATION_EXPECTATIONS, MAX_EVALUATION_NAME_CHARS, MAX_EVALUATION_OUTCOME_CHARS } from "@/domain/evaluation/types";

const names = z.array(z.string().trim().min(1).max(MAX_EVALUATION_NAME_CHARS)).max(MAX_EVALUATION_EXPECTATIONS);
const schema = z.object({
  token: z.string().min(1).max(MAX_EVALUATION_TOKEN_CHARS),
  expectations: z.object({ skills: names, tools: names, outcome: z.string().max(MAX_EVALUATION_OUTCOME_CHARS) }).strict(),
  locale: z.enum(["en", "ko"]),
}).strict();

export const POST = async (request: Request, ctx: { params: Promise<{ name: string }> }) => {
  const { name } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) return principal;
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const agent = await agentUseCases.get(name);
    const result = await evaluationUseCases.evaluate({ ...parsed.data, agent,
      configuration: requireAgentConfiguration(agent), ...principalRunContext(principal, name), signal: request.signal });
    return Response.json(result);
  } catch (error) { return apiError(error, request); }
};
