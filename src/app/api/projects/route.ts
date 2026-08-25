import { tierMayCreateProjects } from "@/domain/member/tiers";
import { withAuth } from "@/lib/session";
import { createProjectWithInitialVersion, projectUseCases } from "@/lib/container";
import { createProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

export const GET = withAuth(async (user) => {
  // One argument on purpose: `map` would otherwise pass the index where
  // sanitizeProject now takes its options.
  return Response.json(
    (await projectUseCases.listAccessible(user.email)).map((project) => sanitizeProject(project)),
  );
});

export const POST = withAuth(async (user, request: Request) => {
  // Project creation is a tier capability. An admin-list entry grants access
  // to administration, but does not widen the stored tier's spend surface.
  // The same predicate hides the console's "New project" button; this 403 is
  // the backstop, not the UX.
  if (!tierMayCreateProjects(user.tier)) {
    return Response.json({ error: "Your tier does not allow creating projects" }, { status: 403 });
  }
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = createProjectSchema.safeParse(body);
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
