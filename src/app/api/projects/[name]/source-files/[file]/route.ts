import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

export const GET = withMemberAuth(async (user, _request: Request, context: { params: Promise<{ name: string; file: string }> }) => {
  try {
    const { name, file } = await context.params;
    const runtime = getAudioRuntime();
    await runtime.authorize(name, user.email);
    const result = await runtime.files.read(name, file, user.email);
    return new Response(new Uint8Array(result.bytes), { headers: {
      "content-type": "application/octet-stream", "cache-control": "private, no-store",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.file.filename)}`,
      "x-content-type-options": "nosniff",
    } });
  } catch (error) { return apiError(error); }
});
