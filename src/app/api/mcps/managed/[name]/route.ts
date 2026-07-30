import { z } from "zod";
import { managedMcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { managedMcpUnavailable as unavailable } from "../_unavailable";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  image: z.string().trim().min(1).optional(),
  containerPort: z.number().int().min(1).max(65535).optional(),
  envRefs: z.array(z.string().trim().min(1)).optional(),
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
    return Response.json(await managedMcpUseCases.update(parseName(name), parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

/** Removes the container and the entry together; neither outlives the other. */
export const DELETE = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  if (!managedMcpUseCases) {
    return unavailable();
  }
  const { name } = await ctx.params;
  try {
    await managedMcpUseCases.remove(parseName(name));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
