import { z } from "zod";
import { mcpUseCases } from "@/lib/container";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { REPO_OWNED, repoOwnedRefusal } from "@/app/api/_lib/repoOwned";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  url: z.url().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    return Response.json(await mcpUseCases.get(parseName(name)));
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
    // The repo owns a synced entry's document fields; credentials are this
    // console's. So a headers-only patch passes — that is where an operator
    // sets the token a repository must never carry — while url, description
    // and content are refused.
    const { url, description, content } = parsed.data;
    if (url !== undefined || description !== undefined || content !== undefined) {
      const refused = repoOwnedRefusal(await mcpUseCases.get(parseName(name)), REPO_OWNED.edit);
      if (refused) {
        return refused;
      }
    }
    return Response.json(await mcpUseCases.update(parseName(name), parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAdminAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    const existing = await mcpUseCases.get(parseName(name));
    const refused = repoOwnedRefusal(existing, REPO_OWNED.remove);
    if (refused) {
      return refused;
    }
    // Deleting a managed entry here would remove the row and leave the
    // container running with nothing left that remembers it — only the
    // managed route's remove also stops the workload.
    if (existing.runtime === "managed") {
      return Response.json(
        { error: "Managed entry — delete it through /api/mcps/managed/{name}, which also stops the container." },
        { status: 400 },
      );
    }
    await mcpUseCases.remove(parseName(name), user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
