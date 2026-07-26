import { z } from "zod";
import { managedMcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

/**
 * Creating a managed MCP server starts a container on this app's host, so it
 * is admin-gated like every other registry mutation — and takes an image, never
 * a command. The name is a slug because it is also the container's name.
 */
const bodySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  image: z.string().min(1),
  containerPort: z.number().int().min(1).max(65535),
  envRefs: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const POST = withAdminAuth(async (_user, request: Request) => {
  if (!managedMcpUseCases) {
    return Response.json(
      { error: "This deployment is not configured to run managed MCP servers." },
      { status: 503 },
    );
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await managedMcpUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
