import { z } from "zod";
import { a2aClientKeyUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";
import { ValidationError } from "@/application/errors";
import { editorBody } from "@/app/api/_lib/body";

/**
 * Named inbound-A2A client keys. Admin-only, like the shared key beside them:
 * both credentials open every published project, so issuing one is an
 * app-level act, not a project setting.
 */

const createSchema = z.object({
  // The name becomes a partition key and the permanent actor id `a2a:{name}`,
  // so it is bounded here like `departmentCode`: past the GSI key limit an
  // unbounded name would surface as a storage 500 instead of a 400.
  name: z.string().min(1).max(64),
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
    const body = await editorBody(request);
    if (body instanceof Response) {
      return body;
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("name is required and must be at most 64 characters");
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
