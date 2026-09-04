import { managedMcpUseCases, mcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { REPO_OWNED, repoOwnedRefusal } from "@/app/api/_lib/repoOwned";
import { managedMcpUnavailable as unavailable } from "../_unavailable";
import { updateManagedMcpSchema } from "../_schema";

type RouteContext = { params: Promise<{ name: string }> };

/** What is actually running, which the stored entry cannot say on its own. */
export const GET = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return unavailable();
  }
  const { name } = await ctx.params;
  try {
    return Response.json(await managedMcpUseCases.status(parseName(name)));
  } catch (error) {
    return apiError(error);
  }
});

/** Updates stored settings and restarts automatically when the workload spec changed. */
export const PUT = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return unavailable();
  }
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = updateManagedMcpSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  const { name } = await ctx.params;
  try {
    // A synced managed entry splits ownership: the repo owns the document
    // fields, this console owns the workload (image, ports, env) and the
    // credentials. Only the former are refused.
    if (parsed.data.description !== undefined || parsed.data.content !== undefined) {
      const refused = repoOwnedRefusal(await mcpUseCases.get(parseName(name)), REPO_OWNED.edit);
      if (refused) {
        return refused;
      }
    }
    return Response.json(await managedMcpUseCases.update(parseName(name), parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

/** Removes the container and the entry together; neither outlives the other. */
export const DELETE = withAdminAuth(async (user, _request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return unavailable();
  }
  const { name } = await ctx.params;
  try {
    const refused = repoOwnedRefusal(await mcpUseCases.get(parseName(name)), REPO_OWNED.remove);
    if (refused) {
      return refused;
    }
    await managedMcpUseCases.remove(parseName(name), user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
