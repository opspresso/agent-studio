import { randomUUID } from "node:crypto";
import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { fileRetentionSchema } from "@/app/api/agents/_lib/audioSchemas";
import { BodyTooLargeError, refuseDeclaredLength } from "@/shared/httpBody";
import { baseMimeType } from "@/domain/artifact/types";

/** Raw streamed upload: file bytes never enter a JSON editor body or model message. */
export const POST = withMemberAuth(async (user, request: Request, context: { params: Promise<{ name: string }> }) => {
  const query = new URL(request.url).searchParams;
  const retention = fileRetentionSchema.safeParse({ unit: query.get("unit"), value: Number(query.get("value")), timezone: query.get("timezone") });
  if (!retention.success) return invalidRequest(retention.error);
  if (!request.body) return Response.json({ error: "A file body is required" }, { status: 400 });
  try {
    const { name } = await context.params;
    const runtime = getAudioRuntime();
    await runtime.authorize(name, user.email);
    const filename = decodeURIComponent(request.headers.get("x-filename") ?? "audio");
    const stream = request.body;
    const file = await runtime.files.import({ id: randomUUID(), agentName: name, userEmail: user.email,
      filename, mimeType: baseMimeType(request.headers.get("content-type") ?? "application/octet-stream"),
      retention: retention.data }, async (maxBytes) => {
      await refuseDeclaredLength(request, maxBytes);
      const reader = stream.getReader();
      let closed = false;
      const close = async () => { if (closed) return; closed = true; await reader.cancel().catch(() => {}); reader.releaseLock(); };
      return Object.assign((async function* () {
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; }
        } finally { await close(); }
      })(), { close });
    }, request.signal);
    return Response.json(file, { status: 201 });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return Response.json({ error: "File exceeds the upload limit" }, { status: 413 });
    if (error instanceof URIError) return Response.json({ error: "Invalid filename encoding" }, { status: 400 });
    return apiError(error);
  }
});
