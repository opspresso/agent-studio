import type { ExecuteAgentInput } from "@/application/execution/deps";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { RunActor, RunCaller, RunConversation } from "@/domain/execution/actor";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import { MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import { collectedWarning, isTopLevelChunk } from "@/domain/llm/types";
import type { ChatMessageInput, ContentPart, EngineChunk } from "@/domain/llm/types";
import type { HistoryTurn, InboundAttachment } from "@/domain/messaging/inbound";
import type { ReplyChannel, ReplyImage } from "@/domain/messaging/reply";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import {
  fileRefOf,
  resolveProducedFiles,
  type ProducedFileRef,
} from "@/application/artifact/producedFiles";
import { RECORD_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";
import { turnContent } from "@/application/llm/documentParts";
import { log } from "@/shared/logger";
import { INTERACTIVE_RUN_TIMEOUT_MS } from "@/shared/runDeadline";
import {
  collectDocuments,
  collectImageParts,
  withHistoryImages,
} from "./attachments";

/**
 * The turn a chat-bot surface runs, once its adapter has said who is asking
 * and where the answer goes — the one pipeline every messaging adapter shares.
 *
 * What is here is what does not depend on the platform: how attachments become
 * a turn, how the run's chunks become progress and text on the sink, and what
 * the reply carries beside the answer once the run is over — the pictures, the
 * links to files it produced, and every warning it raised, in that order.
 * What is *not* here is everything a platform decides for itself: which
 * events are for the bot, how history is read, who the person is, and how the
 * reply is rendered — those come in on {@link TurnInput} and {@link ReplyChannel}.
 *
 * Extracted from the Slack handler when Telegram became the second surface to
 * need it. Two copies of this loop is how the image and file axes had already
 * drifted apart across six other consumers.
 */

/** Injected dependencies a messaging adapter's bag carries. */
export interface MessagingDeps {
  /** Bound wrapper over `executeAgent(executionDeps, params)`. */
  runAgent: (params: ExecuteAgentInput) => AsyncGenerator<EngineChunk>;
  projects: ProjectRepository;
  versions: VersionRepository;
  /**
   * Reads an attached document into the text a turn carries. Required rather
   * than optional: a deployment that forgot to wire it would drop every attached
   * file with the same warning the old image-only path used, which is exactly
   * the silence this replaced.
   */
  documents: DocumentExtractor;
  /**
   * Signs an address for a file this run produced.
   *
   * A thread cannot be handed the bytes — the run bracket stored the document
   * and stripped the payload before any of this saw it — so a link is what a
   * reader gets. Optional because a deployment may have no object storage, and
   * then the reply says so rather than silently answering with prose about a
   * report nobody can open.
   */
  signFile?: SignObjectUrl;
}

/** One inbound turn, normalised by its adapter. */
export interface TurnInput {
  project: Project;
  version: Version;
  /**
   * What the person wrote, as the model should read it — the surface has
   * already stripped its own mention markup and, where it labels speakers,
   * prefixed the name. Empty when only files came.
   */
  text: string;
  attachments: InboundAttachment[];
  /** Earlier turns, oldest first, already cut to what this surface carries. */
  history: HistoryTurn[];
  actor?: RunActor;
  /** Who is asking, when the surface resolved it. The facade gates it on the version. */
  caller?: RunCaller;
  conversation: RunConversation;
  /** The user's gallery and MCP identity, when the surface knows an email address. */
  ownerEmail?: string;
  /**
   * What the surface lost before the run — a history it could not read. The
   * pipeline appends its own and every one rides out with the answer.
   */
  warnings: string[];
}

/** What the run left on the surface, for the adapter's log and bookkeeping. */
export interface TurnOutcome {
  /** The top-level answer as delivered. */
  text: string;
  /** How many pictures the surface accepted — attempts that failed are warnings, not deliveries. */
  imagesDelivered: number;
  /** How many produced files were linked under the answer. */
  filesDelivered: number;
  /** Everything reported beside the answer, in order. */
  warnings: string[];
}

/**
 * There was nothing to ask. Thrown rather than returned so the one `finally`
 * that stops the status heartbeat still runs, and caught without a warning of
 * its own: the reason every attachment failed is already in `warnings`, and
 * "agent run failed" on top of it would blame the run for not starting.
 */
class EmptyTurnError extends Error {}

/** Run the agent for one turn and deliver its reply through the channel. */
export async function handleTurn(
  deps: MessagingDeps,
  input: TurnInput,
  reply: ReplyChannel,
): Promise<TurnOutcome> {
  const { project, version, warnings } = input;
  let text = "";
  // `fetched` rides along: what the run read is delivered only when it is all
  // the run has to show (see below).
  const images: Array<ReplyImage & { fetched?: boolean }> = [];
  // Documents a tool rendered. Not delivered like the images below them: their
  // bytes were stripped at the bracket the moment they were stored, so the
  // reply gets a link. Without this the run answered "here is the report" into
  // a conversation with no report in it.
  //
  // References while the run goes, addresses after it: a link signed as the
  // chunk passed would start expiring minutes before the reply carrying it was
  // posted, and a run is allowed to last ten of them.
  const producedRefs: ProducedFileRef[] = [];
  // Enforced by an abort signal so a run that stops producing chunks entirely
  // (hung provider or tool) still ends and reports a timeout instead of
  // leaving the status up forever.
  const deadline = AbortSignal.timeout(INTERACTIVE_RUN_TIMEOUT_MS);
  // The heartbeat starts *before* the attachments are fetched, not before the
  // run: a 10MB document, or the history's pictures re-downloaded, is a stretch
  // of round trips during which nothing else says the bot is working — and on
  // a surface whose status expires in seconds (Telegram's typing indicator),
  // that stretch was a bot that received the file and did nothing.
  const stopStatusHeartbeat = reply.keepStatusAlive();
  let userContent: string | ContentPart[] = "";
  let history: ChatMessageInput[] = [];
  try {
    const attached = input.attachments;
    const imageParts = attached.length > 0 ? await collectImageParts(attached, warnings) : [];
    const readDocuments =
      attached.length > 0 ? await collectDocuments(deps.documents, attached, warnings) : [];
    // Assembled by the one function that owns a turn's body, so a chat bot and a
    // chat put the same message in front of the model.
    userContent = turnContent(readDocuments, input.text, imageParts);
    // Whatever budget the current message left goes to the newest history images,
    // so "make the picture I sent blue" still has the picture.
    history = await withHistoryImages(
      input.history,
      MAX_IMAGES_PER_TURN - imageParts.length,
      warnings,
    );
    // Nothing survived to ask about. A file-only message whose every attachment
    // failed — a scanned PDF is the ordinary case — would otherwise dispatch a
    // user turn with empty content, which providers reject or answer with
    // whatever an empty prompt evokes. The warnings already say what happened
    // and they are the whole answer, so the reply is those alone.
    if (typeof userContent === "string" && userContent === "") {
      throw new EmptyTurnError();
    }
    const messages: ChatMessageInput[] = [...history, { role: "user", content: userContent }];
    for await (const chunk of deps.runAgent({
      project,
      version,
      messages,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.caller ? { caller: input.caller } : {}),
      conversation: input.conversation,
      ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
      signal: deadline,
    })) {
      if (chunk.error) {
        warnings.push(chunk.error);
        // A subagent's failure reaches the parent as a tool error and the parent
        // often answers anyway (a refused transfer, an unusable child model), so
        // only a top-level failure ends the run.
        if (isTopLevelChunk(chunk)) {
          break;
        }
        continue;
      }
      // A binding the run could not use. It rides out with the answer rather
      // than replacing it — the run still produced one. `collectedWarning`
      // owns which ones count.
      const warning = collectedWarning(chunk, warnings);
      if (warning) {
        warnings.push(warning);
      }
      // Tool activity is reported as steps rather than in the answer: a
      // tool-heavy first turn shows what is happening without spending the
      // message body on it, and where the surface renders a checklist the steps
      // accumulate into one.
      //
      // Every tool the chunk announced, not just the first: a model that fans
      // out calls in one response puts them side by side in this array, and
      // reading index 0 alone reported one of them and hid the rest.
      //
      // A subagent's calls are listed too, named by the agent that made them —
      // the checklist is what the run is doing, and a hand-off's work is still
      // the run's work.
      for (const call of chunk.delta?.toolCalls ?? []) {
        const name = call.function?.name;
        // Arguments stream in after the name, so a later delta for the same
        // call carries neither and is not a step of its own.
        if (call.id && name) {
          await reply.step(call.id, chunk.author ? `${chunk.author}: ${name}` : name, {
            nested: !isTopLevelChunk(chunk),
          });
        }
      }
      // The one real completion boundary a run has. Nothing else may tick a
      // step off: a status changing means the run stopped saying something, not
      // that it finished it.
      if (chunk.toolResult) {
        await reply.stepDone(
          chunk.toolResult.toolCallId,
          // The result names what the call acted on — the skill it loaded, the
          // server an MCP tool came from — which the call's own name never does.
          chunk.author ? `${chunk.author}: ${chunk.toolResult.name}` : chunk.toolResult.name,
        );
      }
      if (chunk.image) {
        images.push(chunk.image);
      }
      if (chunk.file) {
        producedRefs.push(fileRefOf(chunk.file));
      }
      const content = chunk.delta?.content;
      if (content && isTopLevelChunk(chunk)) {
        text += content;
        await reply.push(text);
      }
    }
  } catch (error) {
    if (!(error instanceof EmptyTurnError)) {
      warnings.push(
        deadline.aborted
          ? "Agent run timed out"
          : error instanceof Error
            ? error.message
            : "agent run failed",
      );
    }
  } finally {
    stopStatusHeartbeat();
  }

  // A picture the run only *read* is worth delivering when it is all the run
  // has to show — "show me the image at this address" is answered by it. Beside
  // something the run drew it is the source material, and delivering both turns
  // "redraw my avatar" into two pictures where one was asked for.
  //
  // A conversation is where this matters and a chat is not: each picture here
  // is its own message and its own notification, while a chat renders inline in
  // a conversation already flowing past.
  const drawn = images.filter((image) => !image.fetched);
  const uploads = drawn.length > 0 ? drawn : images;

  log.info(
    "messaging",
    `run done project=${project.name} chars=${text.length} images=${uploads.length} warnings=${warnings.length}`,
  );
  let imagesDelivered = 0;
  for (const [index, image] of uploads.entries()) {
    try {
      await reply.sendImage(image, index);
      imagesDelivered += 1;
    } catch (error) {
      log.error("messaging", "image upload failed", error);
      warnings.push(`Image upload failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  // Signed here, one step before the message goes out, and for a window that
  // suits a record rather than an open page: a conversation is read minutes
  // later by the person who asked and days later by whoever searches it.
  const produced = await resolveProducedFiles(producedRefs, deps.signFile, RECORD_URL_TTL_SECONDS);
  for (const warning of produced.warnings) {
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  }
  // Only this scope knows whether *anything* reached the reader — the sink sees
  // the text and not the delivered images, which is how a run that answered
  // purely with a picture used to be captioned "(no response)". A produced file
  // counts for the same reason: it is the deliverable, and the link below is the
  // only place the reply carries it.
  if (!text && uploads.length === 0 && producedRefs.length === 0 && warnings.length === 0) {
    warnings.push("The run finished without producing an answer.");
  }
  // Links first, warnings after: one is what the run made and the other is what
  // it lost, and a reader scanning the end of a reply should meet them in that
  // order.
  const suffix = [
    // `resolveProducedFiles` hands back only files it could address; the guard
    // is what the type still leaves open, not a case that occurs.
    ...produced.files.flatMap((file) =>
      file.url ? [reply.fileLink({ url: file.url, name: file.name })] : [],
    ),
    ...warnings.map((warning) => reply.warningLine(warning)),
  ].join("\n");
  await reply.finish(text, suffix);
  return { text, imagesDelivered, filesDelivered: produced.files.length, warnings };
}
