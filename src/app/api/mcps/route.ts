import { z } from "zod";
import { mcpUseCases } from "@/application/mcp";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

const createSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be a slug (lowercase letters, digits, hyphens)"),
  url: z.url(),
  description: z.string().optional(),
  content: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
});

export const GET = withAuth(async () => {
  return Response.json(await mcpUseCases.list());
});

export const POST = withAdminAuth(async (_user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await mcpUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
