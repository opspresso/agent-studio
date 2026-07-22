import { z } from "zod";
import { agentUseCases } from "@/application/agent";
import { withAdminAuth, withAuth } from "@/lib/session";
import { SsrfError } from "@/infrastructure/net/ssrfGuard";

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

export const POST = withAdminAuth(async (_user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  let agent;
  try {
    agent = await agentUseCases.create(parsed.data);
  } catch (error) {
    if (error instanceof SsrfError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (!agent) {
    return Response.json({ error: "An agent with that name already exists" }, { status: 409 });
  }
  return Response.json(agent, { status: 201 });
});
