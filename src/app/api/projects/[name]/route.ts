import { withAuth } from "@/lib/session";
import { isEffectiveConfiguredAdmin } from "@/lib/memberAccess";
import { projectUseCases } from "@/lib/container";
import { projectNameSchema, updateProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const project = await projectUseCases.assertAccessible(name, user.email);
    // The invite list travels only to whoever manages the project — the same
    // pair `assertProjectWritable` admits — because it is a roster of other
    // people's addresses, not part of what "seeing the project" grants.
    const manages =
      project.ownerEmail === user.email || (await isEffectiveConfiguredAdmin(user));
    return Response.json(sanitizeProject(project, { withMemberEmails: manages }));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    // The update is owner-or-admin gated, so whoever got this far manages the
    // project and may see the normalized invite list they just wrote.
    return Response.json(
      sanitizeProject(await projectUseCases.update(name, parsed.data, user.email), {
        withMemberEmails: true,
      }),
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!projectNameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid project name" }, { status: 400 });
  }
  try {
    await projectUseCases.remove(name, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
