import { z } from "zod";
import { managedMcpUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { MANAGED_NAME } from "@/shared/slug";
import { managedMcpUnavailable } from "./_unavailable";

/**
 * Creating a managed MCP server starts a container on this app's host, so it
 * is admin-gated like every other registry mutation. The name is a slug because
 * it is also the container's name; args remain an argv array, never a shell command.
 */
const bodySchema = z.object({
  name: z.string().regex(MANAGED_NAME),
  image: z.string().trim().min(1),
  containerPort: z.number().int().min(1).max(65535),
  envRefs: z.array(z.string().trim().min(1)).optional(),
  environment: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16_384))
    .refine((values) => values.PORT === undefined, "PORT is managed by the runtime")
    .optional(),
  args: z
    .array(z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/))
    .max(64)
    .optional(),
  endpointPath: z.string().trim().regex(/^\/(?!\/)[^\s?#]*$/).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const POST = withAdminAuth(async (_user, request: Request) => {
  if (!managedMcpUseCases) {
    return managedMcpUnavailable();
  }
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await managedMcpUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
