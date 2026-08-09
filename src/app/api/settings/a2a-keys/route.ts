import { z } from "zod";
import { a2aClientKeyUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";
import { ValidationError } from "@/application/errors";

/**
 * Named inbound-A2A client keys. Admin-only, like the shared key beside them:
 * both credentials open every published project, so issuing one is an
 * app-level act, not a project setting.
 */

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(4000).optional(),
});

export const GET = withAdminAuth(async () => {
  try {
    return Response.json({ items: await a2aClientKeyUseCases.list() });
  } catch (error) {
    return apiError(error);
  }
});

/** Issue a key for a new client. The raw key comes back exactly once. */
export const POST = withAdminAuth(async (user, request: Request) => {
  try {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("name is required");
    }
    const { key, view } = await a2aClientKeyUseCases.create(
      parsed.data.name,
      parsed.data.description,
      user.email,
    );
    return Response.json({ key, view });
  } catch (error) {
    return apiError(error);
  }
});
