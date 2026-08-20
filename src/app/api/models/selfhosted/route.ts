import { ValidationError } from "@/application/errors";
import { selfHostedDeclarationIds } from "@/domain/llm/models";
import { listSelfHostedServedModels } from "@/lib/container";
import { getSelfHostedModels } from "@/lib/runtime-settings";
import { apiError } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";

/**
 * GET /api/models/selfhosted — everything the console's Self-hosted section
 * edits and displays: the **stored** declarations (the editing basis — a
 * declaration the registry refused to install must stay visible here, or the
 * next full-replace save deletes it silently), which of them are installed,
 * and what the channel is serving right now (the declaration aid, from the
 * channel's own `/v1/models`, LM Studio-enriched).
 *
 * `served` is best-effort: a channel that does not answer becomes
 * `servedError` rather than a failed view — the declarations are still the
 * admin's to edit while the serving stack is down. No channel at all is still
 * a 400; the section only exists behind one. Declaring itself stays
 * `PUT /api/settings`.
 */
export const GET = withAdminAuth(async () => {
  try {
    const declarations = await getSelfHostedModels();
    const installed = selfHostedDeclarationIds();
    try {
      return Response.json({
        served: await listSelfHostedServedModels(),
        declarations,
        installed,
      });
    } catch (error) {
      // No channel configured is the caller's mistake; a channel that did not
      // answer is a finding the section shows beside the editable list.
      if (error instanceof ValidationError) {
        throw error;
      }
      return Response.json({
        served: null,
        servedError: error instanceof Error ? error.message : String(error),
        declarations,
        installed,
      });
    }
  } catch (error) {
    return apiError(error);
  }
});
