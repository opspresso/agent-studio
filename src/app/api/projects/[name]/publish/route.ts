import { withAuth } from "@/lib/session";
import { versionUseCases } from "@/lib/container";
import { publishSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = publishSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await versionUseCases.publish(name, parsed.data.versionName, user.email);
    return Response.json(sanitizeProject(project));
  } catch (error) {
    return apiError(error);
  }
});
