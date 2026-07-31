import { withAuth } from "@/lib/session";
import { executionDeps, projectRepository, secretCipher, versionRepository } from "@/lib/container";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { previewPrompt } from "@/application/execution/runProject";
import { previewPromptSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import type { McpBinding } from "@/domain/project/types";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Resolve header overrides the editor echoed back masked.
 *
 * The console reads a version's overrides masked, so a draft round-tripped
 * through the form carries `ab••••••yz` where a secret was. That is not a
 * credential: sending it fails outright (a header must be a ByteString, and the
 * reveal character is not), and where it does not fail it leaks the secret's
 * edges to the server. The save path already resolves them against what is
 * stored; a preview claims to show what a run would send, so it has to do the
 * same or it is describing a different request.
 *
 * Anything with no counterpart in the saved version is left as it came — a
 * freshly typed value is not a mask, and `mergeHeaderOverrideUpdate` drops a
 * mask that matches nothing rather than passing it on.
 */
async function resolveMaskedOverrides(
  projectName: string,
  versionName: string | undefined,
  bindings: McpBinding[],
): Promise<McpBinding[]> {
  if (!versionName || !bindings.some((binding) => binding.headers)) {
    return bindings;
  }
  const saved = await versionRepository.get(projectName, versionName);
  if (!saved) {
    // Editing a version that no longer exists. Nothing to resolve against, and
    // the masks that remain are dropped at dispatch rather than sent.
    return bindings;
  }
  const storedByName = new Map(saved.mcpList.map((binding) => [binding.name, binding]));
  return bindings.map((binding) =>
    binding.headers
      ? {
          ...binding,
          headers: secretCipher.mergeHeaderOverrideUpdate(
            storedByName.get(binding.name)?.headers ?? {},
            binding.headers,
          ),
        }
      : binding,
  );
}

/**
 * Assemble what the draft in the editor would send, without running it.
 *
 * Owner or admin, unlike reading or running a project: the body is an unsaved
 * version, and its MCP bindings may override the outbound headers a request
 * carries to a registered server — the same authority saving a version has.
 * The URL always comes from the registry, so the SSRF surface is a run's.
 */
export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = previewPromptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await assertProjectWritable(projectRepository, name, user.email);
    const { variables, versionName, ...draft } = parsed.data;
    const preview = await previewPrompt(executionDeps, {
      project,
      version: {
        ...draft,
        mcpList: await resolveMaskedOverrides(name, versionName, draft.mcpList),
        projectName: name,
        // The draft may not be saved yet, so it has no name or timestamp of its
        // own; neither reaches the assembled prompt.
        versionName: "draft",
        createdAt: new Date().toISOString(),
      },
      variables,
    });
    return Response.json(preview);
  } catch (error) {
    return apiError(error);
  }
});
