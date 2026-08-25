import { z } from "zod";
import { isSlug, SLUG_RULE } from "@/domain/naming";
import { agentUseCases } from "@/lib/container";
import { withAdminAuth, withMemberAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

const createSchema = z.object({
  name: z.string().refine(isSlug, `name ${SLUG_RULE}`),
  url: z.url(),
  protocol: z.enum(["openai", "a2a"]).default("openai"),
  description: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
});

export const GET = withMemberAuth(async () => {
  return Response.json(await agentUseCases.list());
});

export const POST = withAdminAuth(async (_user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await agentUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
