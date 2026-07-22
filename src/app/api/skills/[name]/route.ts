import { z } from "zod";
import { skillUseCases } from "@/application/skill";
import { withAdminAuth, withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

const nameSchema = z.string().regex(/^[a-z0-9-]+$/);
const updateSchema = z.object({
  description: z.string().min(1).optional(),
  content: z.string().optional(),
});

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const skill = await skillUseCases.get(name);
  if (!skill) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
  return Response.json(skill);
});

export const PUT = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const skill = await skillUseCases.update(name, parsed.data);
  if (!skill) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
  return Response.json(skill);
});

export const DELETE = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const removed = await skillUseCases.remove(name);
  if (!removed) {
    return Response.json({ error: "Skill not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
});
