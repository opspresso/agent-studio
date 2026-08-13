import { tierMayCreateProjects } from "@/domain/member/tiers";
import { isAdmin, withAuth } from "@/lib/session";
import { createProjectWithInitialVersion, projectUseCases } from "@/lib/container";
import { createProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";

export const GET = withAuth(async () => {
  return Response.json((await projectUseCases.list()).map(sanitizeProject));
});

export const POST = withAuth(async (user, request: Request) => {
  // A permission gate, and tier is additive to permissions — so an effective
  // admin passes whatever their stored tier reads as (the `ADMIN_EMAILS`
  // bootstrap admin's row defaults like everyone else's). The same pair hides
  // the console's "New project" button; this 403 is the backstop, not the UX.
  if (!tierMayCreateProjects(user.tier) && !(await isAdmin(user))) {
    return Response.json({ error: "Your tier does not allow creating projects" }, { status: 403 });
  }
  const parsed = createProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    // Project plus its initial version "1" — see createProjectFlow.ts for why
    // the version is created and deliberately not published.
    const project = await createProjectWithInitialVersion({
      ...parsed.data,
      ownerEmail: user.email,
    });
    return Response.json(sanitizeProject(project), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
