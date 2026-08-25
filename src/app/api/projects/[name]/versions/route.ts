import { withAuth } from "@/lib/session";
import { projectUseCases, versionUseCases } from "@/lib/container";
import { createVersionSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    // A version is the project's configuration, so reading one is reading the
    // project: the visibility gate applies before anything is listed.
    await projectUseCases.assertAccessible(name, user.email);
  } catch (error) {
    return apiError(error);
  }
  const versions = await versionUseCases.list(name);
  // Called with one argument on purpose: `map` would otherwise pass the index
  // and the array too, which is silent today and is not once `toView` grows a
  // second parameter.
  return Response.json(versions.map((version) => versionUseCases.toView(version)));
});

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = createVersionSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const version = await versionUseCases.create(name, parsed.data, user.email);
    return Response.json(versionUseCases.toView(version), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
