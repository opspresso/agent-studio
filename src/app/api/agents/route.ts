import { z } from "zod";
import { agentUseCases } from "@/application/agent";
import { withAuth } from "@/lib/session";

const createSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be a slug (lowercase letters, digits, hyphens)"),
  url: z.url(),
  protocol: z.enum(["openai", "a2a"]).default("openai"),
  description: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
});

export const GET = withAuth(async () => {
  return Response.json(await agentUseCases.list());
});

export const POST = withAuth(async (_user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const agent = await agentUseCases.create(parsed.data);
  if (!agent) {
    return Response.json({ error: "An agent with that name already exists" }, { status: 409 });
  }
  return Response.json(agent, { status: 201 });
});
