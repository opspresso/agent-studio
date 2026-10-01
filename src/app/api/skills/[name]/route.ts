import { z } from "zod";
import { skillUseCases } from "@/lib/container";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { REPO_OWNED, repoOwnedRefusal } from "@/app/api/_lib/repoOwned";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  description: z.string().min(1).optional(),
  content: z.string().optional(),
});

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    return Response.json(await skillUseCases.get(parseName(name)));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const { name } = await ctx.params;
    // A repo-owned skill is the repository's whole — the sync would replace
    // the edit on its next run, so the console refuses instead of pretending.
    const refused = repoOwnedRefusal(await skillUseCases.get(parseName(name)), REPO_OWNED.edit);
    if (refused) {
      return refused;
    }
    return Response.json(await skillUseCases.update(parseName(name), parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAdminAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    const refused = repoOwnedRefusal(await skillUseCases.get(parseName(name)), REPO_OWNED.remove);
    if (refused) {
      return refused;
    }
    await skillUseCases.remove(parseName(name), user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
