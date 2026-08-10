import { withAuth } from "@/lib/session";
import { usageUseCases } from "@/lib/container";
import { invalidRequest } from "@/app/api/_lib/http";
import { summaryQuerySchema } from "./validation";

export const GET = withAuth(async (_user, request: Request) => {
  const params = new URL(request.url).searchParams;
  const parsed = summaryQuerySchema.safeParse({
    from: params.get("from"),
    to: params.get("to"),
    project: params.get("project") ?? undefined,
  });

  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }

  const { from, to, project } = parsed.data;
  return Response.json({ items: await usageUseCases.summary(from, to, project) });
});
