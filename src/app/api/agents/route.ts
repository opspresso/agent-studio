import { z } from "zod";
import { agentUseCases } from "@/application/agent";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

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
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await agentUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
