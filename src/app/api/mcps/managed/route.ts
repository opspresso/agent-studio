import { managedMcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { managedMcpUnavailable } from "./_unavailable";
import { createManagedMcpSchema } from "./_schema";

/**
 * Creating a managed MCP server starts a container on this app's host, so it
 * is admin-gated like every other registry mutation. The name is a slug because
 * it is also the container's name; args remain an argv array, never a shell command.
 */
export const POST = withAdminAuth(async (_user, request: Request) => {
  if (!managedMcpUseCases) {
    return managedMcpUnavailable();
  }
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = createManagedMcpSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await managedMcpUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
