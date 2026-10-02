import { getWorkspaceModelGateway } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { withTurnBodyText } from "@/app/api/_lib/body";
import { ValidationError } from "@/application/errors";

/** Scoped native run tokens, never session cookies or provider credentials. */
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-api-key") ?? "";
    const gateway = getWorkspaceModelGateway();
    await gateway.authorize(token);
    return await withTurnBodyText(request, async text => {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new ValidationError("Invalid native model JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Native model request must be an object");
      return gateway.forward(token, (await context.params).path.join("/"), value as Record<string, unknown>,
        Object.fromEntries(["anthropic-version", "anthropic-beta", "openai-beta"].flatMap(name => {
          const value = request.headers.get(name); return value ? [[name, value]] : [];
        })), request.signal);
    });
  } catch (error) { return apiError(error); }
}
