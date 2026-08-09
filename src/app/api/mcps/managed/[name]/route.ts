import { z } from "zod";
import { managedMcpUseCases, mcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { REPO_OWNED, repoOwnedRefusal } from "@/app/api/_lib/repoOwned";
import { managedMcpUnavailable as unavailable } from "../_unavailable";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  image: z.string().trim().min(1).optional(),
  containerPort: z.number().int().min(1).max(65535).optional(),
  envRefs: z.array(z.string().trim().min(1)).optional(),
  environment: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384))
    .refine((values) => values.PORT === undefined, "PORT is managed by the runtime")
    .optional(),
  args: z
    .array(z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/))
    .max(64)
    .optional(),
  endpointPath: z.string().trim().regex(/^\/(?!\/)[^\s?#]*$/).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

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
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
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
