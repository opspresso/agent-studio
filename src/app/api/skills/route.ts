import { z } from "zod";
import { skillUseCases } from "@/application/skill";
import { withAuth } from "@/lib/session";

const createSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be a slug (lowercase letters, digits, hyphens)"),
  description: z.string().min(1),
  content: z.string(),
});

export const GET = withAuth(async () => {
  return Response.json(await skillUseCases.list());
});

export const POST = withAuth(async (_user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const skill = await skillUseCases.create(parsed.data);
  if (!skill) {
    return Response.json({ error: "A skill with that name already exists" }, { status: 409 });
  }
  return Response.json(skill, { status: 201 });
});
