import { verifyTelegramSecret, TELEGRAM_SECRET_HEADER } from "@/infrastructure/telegram/verify";
import { telegramClient } from "@/infrastructure/telegram/client";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { telegramUpdateRepository } from "@/infrastructure/db/repositories/telegramUpdateRepository";
import { telegramDestinationRepository } from "@/infrastructure/db/repositories/telegramDestinationRepository";
import { transcriptRepository } from "@/infrastructure/db/repositories/transcriptRepository";
import {
  signArtifactUrl,
  executionDeps,
  projectRepository,
  versionRepository,
} from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { botIdFromToken, classifyTelegramUpdate } from "@/application/telegram/engagement";
import { handleTelegramUpdate } from "@/application/telegram/handleUpdate";
import type { TelegramEventBinding } from "@/application/telegram/projectTelegram";
import type { TelegramEventDeps, TelegramUpdate } from "@/application/telegram/types";
import { admitInboundEvent, readEventBody } from "@/app/api/_lib/inboundEvent";
import { log } from "@/shared/logger";

const telegramEventDeps: TelegramEventDeps = {
  runAgent: (params) => executeAgent(executionDeps, params),
  projects: projectRepository,
  versions: versionRepository,
  telegram: telegramClient,
  destinations: telegramDestinationRepository,
  documents: documentExtractor,
  // Named even when this deployment has none, so "no object storage here" is a
  // decision in the source rather than a field nobody thought about — which the
  // conditional spread this used to be did not actually do: it left the field
  // out, saying exactly as little as forgetting it would.
  signFile: signArtifactUrl,
  transcripts: transcriptRepository,
  albums: (projectName, botId) => telegramUpdateRepository.forBot(projectName, botId).albums,
};

/**
 * The Telegram webhook pipeline: check the secret → gate → exactly-once claim
 * → ack immediately and process in the background. Telegram retries a delivery
 * that is not answered 2xx promptly, and delivers updates in order one at a
 * time per webhook, so a slow handler would stall every chat behind it — the
 * ack is what keeps that from happening.
 *
 * **The gate is ahead of the claim.** A bot in a group with privacy mode off
 * receives everything the group says; deciding that a message is not for the
 * bot before the claim is what keeps it from costing a write.
 */
export async function handleTelegramUpdateRequest(
  request: Request,
  binding: TelegramEventBinding,
): Promise<Response> {
  const body = await readEventBody(request);
  if (body instanceof Response) {
    return body;
  }
  if (!verifyTelegramSecret(request.headers.get(TELEGRAM_SECRET_HEADER), binding.webhookSecret)) {
    // Logged, like the Slack refusal: "Telegram reached us with the wrong
    // secret" and "Telegram never reached us" must not look the same from
    // outside. The secret itself is never logged; whether the header was
    // present is what narrows it — absent points at something that is not
    // Telegram, present at a webhook registered with another secret.
    log.warn(
      "telegram",
      `project ${binding.projectName}: refused a request whose secret did not verify ` +
        `(header ${request.headers.get(TELEGRAM_SECRET_HEADER) === null ? "missing" : "present"}, ${body.length} byte body)`,
    );
    return Response.json({ error: "Invalid secret" }, { status: 401 });
  }
  let update: TelegramUpdate;
  try {
    update = JSON.parse(body) as TelegramUpdate;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const botId = botIdFromToken(binding.botToken);
  const disposition = classifyTelegramUpdate(update, {
    ...(botId !== undefined ? { botId } : {}),
    ...(binding.botUsername ? { botUsername: binding.botUsername } : {}),
  });
  if (disposition.kind === "ignore") {
    return Response.json({ ok: true });
  }

  const admitted = await admitInboundEvent({
    // Keyed by bot as well as project: an update id is a counter per bot, and
    // a project that changes bots must not have the new bot's early updates
    // refused as duplicates of the old bot's.
    claims: telegramUpdateRepository.forBot(binding.projectName, botId ?? "unknown").updates,
    eventId: typeof update.update_id === "number" ? String(update.update_id) : undefined,
    scope: "telegram",
    logLabel: `project ${binding.projectName}`,
    work: () => handleTelegramUpdate(telegramEventDeps, disposition, binding),
  });
  if (admitted === "duplicate") {
    return Response.json({ ok: true, duplicate: true });
  }
  return Response.json({ ok: true });
}
