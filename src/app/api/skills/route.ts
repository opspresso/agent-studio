import { z } from "zod";
import { skillUseCases } from "@/application/skill";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

const createSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be a slug (lowercase letters, digits, hyphens)"),
  description: z.string().min(1),
  content: z.string(),
});

export const GET = withAuth(async () => {
  return Response.json(await skillUseCases.list());
});

export const POST = withAdminAuth(async (_user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await skillUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
