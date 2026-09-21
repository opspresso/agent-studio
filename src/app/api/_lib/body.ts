import { BodyTooLargeError, readBodyText } from "@/shared/httpBody";
import { base64Chars } from "@/domain/llm/imageLimits";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "@/domain/llm/documentLimits";
import { MAX_SKILL_TOTAL_BYTES } from "@/domain/skill/files";

/**
 * Ceiling on a turn body that carries attachments.
 *
 * Derived rather than picked, so it cannot drift from the caps it protects: the
 * most a legitimate request can hold is every attachment at its own limit, plus
 * room for the prose around them. Documents raised this a great deal — four
 * 10MB files are ~56MB of base64 on their own — and the cost of *not* bounding
 * it is paid before any schema runs: `request.json()` materialises the whole
 * body as a UTF-16 string and `JSON.parse` allocates the base64 again, so an
 * unbounded body is several hundred megabytes of resident memory per request,
 * from any signed-in caller, before a single validator has looked at it. The run
 * bracket's concurrency guard opens later and cannot throttle it.
 */
const ATTACHMENT_ALLOWANCE =
  base64Chars(MAX_DOCUMENT_BYTES) * MAX_DOCUMENTS +
  base64Chars(MAX_IMAGE_BYTES) * MAX_IMAGES_PER_TURN;
/** JSON quoting, field names, and the message itself. */
const PROSE_ALLOWANCE = 256 * 1024;

export const MAX_TURN_BODY_BYTES = ATTACHMENT_ALLOWANCE + PROSE_ALLOWANCE;
/** Bodies above this allowance necessarily carry attachment-scale data. */
export const LARGE_TURN_BODY_BYTES = PROSE_ALLOWANCE;

/**
 * Attachment-scale turn bytes one process retains at once.
 *
 * One legal turn is about 84MB on the wire and temporarily exists as both the
 * decoded JSON text and parsed base64 strings. The execution concurrency guard
 * opens only after this work, so it cannot protect the process from overlapping
 * readers. A charge follows a large parsed body through its run or stream; a
 * body within the prose allowance is free, so ordinary turns are never gated.
 *
 * **A budget rather than a count of requests, because the bodies differ by two
 * orders of magnitude.** A chat carrying one 200KB screenshot is past the prose
 * allowance and would have spent the same permit as a four-document 84MB turn.
 * With permits held for the life of the run — the parsed base64 is in the
 * messages the model is being shown — two people sending screenshots meant
 * everyone else got a 429 for as long as those runs took, which on
 * `MAX_RUN_DURATION_MS` is ten minutes. The heap is what has to be bounded, and
 * charging actual bytes bounds exactly that: the worst case is unchanged, and
 * small attachments now cost what they weigh.
 */
export const MAX_CONCURRENT_LARGE_TURN_BYTES = 2 * MAX_TURN_BODY_BYTES;
const TURN_BODY_READ_STATE = Symbol.for("opspresso.agent-studio.turn-body-reads");
type TurnBodyReadState = { activeBytes: number; budgetBytes: number };

class TurnBodyBusyError extends Error {}

export interface TurnBodyAdmission {
  /** Keep a large body's byte charge until detached work has released its input. */
  retainUntil(completion: PromiseLike<unknown>): void;
}

/** Shared even when separate route bundles evaluate this module more than once. */
function turnBodyReadState(): TurnBodyReadState {
  const processGlobal = globalThis as typeof globalThis & {
    [TURN_BODY_READ_STATE]?: TurnBodyReadState;
  };
  processGlobal[TURN_BODY_READ_STATE] ??= {
    activeBytes: 0,
    budgetBytes: MAX_CONCURRENT_LARGE_TURN_BYTES,
  };
  return processGlobal[TURN_BODY_READ_STATE];
}

/**
 * Test seam: the budget, so exhausting it does not mean allocating the hundred
 * and sixty megabytes the real one is worth. Nothing in the app calls this.
 */
export function setTurnBodyBudgetBytes(bytes = MAX_CONCURRENT_LARGE_TURN_BYTES): void {
  turnBodyReadState().budgetBytes = bytes;
}

/** A 413 with the limit named, so a caller learns the bound rather than guessing. */
export function bodyTooLarge(error: BodyTooLargeError): Response {
  return Response.json({ error: error.message }, { status: 413 });
}

/**
 * Ceiling on a body that carries no attachments.
 *
 * Derived from the largest thing a management route legitimately holds — a
 * skill's whole file set — with room for the prose and JSON quoting around it.
 * These routes have their own per-field caps, but every one of them is checked
 * by zod *after* `JSON.parse` has already allocated the string twice.
 */
const EDITOR_ALLOWANCE = MAX_SKILL_TOTAL_BYTES + PROSE_ALLOWANCE;

/**
 * The body of a registry or Agent settings edit, or the response that refuses it.
 *
 * Separate from {@link withTurnBody} because the two bound different things
 * and the gap between them is three orders of magnitude: a turn may carry four
 * 10MB attachments, and nothing a person types into the console comes close.
 */
export async function editorBody(
  request: Request,
  options: { empty?: unknown } = {},
): Promise<unknown | Response> {
  return boundedBody(request, EDITOR_ALLOWANCE, options);
}

/**
 * The body, or the response that refuses it.
 *
 * Every route that parses a turn goes through here so the declared body length
 * is checked before JSON and base64 strings are resident in memory.
 *
 * It answers with a `Response` rather than throwing so every route shares one
 * refusal shape and an oversize body cannot surface as a route-specific 500.
 */
export async function withTurnBody<T>(
  request: Request,
  consume: (body: unknown, admission: TurnBodyAdmission) => T | Promise<T>,
): Promise<T | Response> {
  return withTurnBodyText(request, async (text, admission) => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    return consume(body, admission);
  });
}

function retainedStreamingResponse(response: Response, release: () => void): Response {
  const source = response.body;
  if (!source) {
    release();
    return response;
  }
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Keep a raw attachment-scale body admitted until its consumer no longer retains it. */
export async function withTurnBodyText<T>(
  request: Request,
  consume: (body: string, admission: TurnBodyAdmission) => T | Promise<T>,
): Promise<T | Response> {
  const state = turnBodyReadState();
  // What this reader has taken out of the shared budget so far. The body grows
  // as it is read, so the charge grows with it and a reader that runs the
  // budget out mid-stream is refused then rather than after it is resident.
  let charged = 0;
  let retained = false;
  let released = false;
  const release = () => {
    if (charged > 0 && !released) {
      released = true;
      state.activeBytes -= charged;
    }
  };
  const admission: TurnBodyAdmission = {
    retainUntil(completion) {
      if (charged === 0 || retained) {
        return;
      }
      retained = true;
      void Promise.resolve(completion).then(release, release);
    },
  };
  try {
    let text: string;
    try {
      text = await readBodyText(request, MAX_TURN_BODY_BYTES, {
        onBytes(totalBytes) {
          if (totalBytes <= LARGE_TURN_BODY_BYTES) {
            return;
          }
          const owed = totalBytes - charged;
          if (owed <= 0) {
            return;
          }
          if (state.activeBytes + owed > state.budgetBytes) {
            throw new TurnBodyBusyError();
          }
          state.activeBytes += owed;
          charged = totalBytes;
        },
      });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return bodyTooLarge(error);
      }
      if (error instanceof TurnBodyBusyError) {
        await request.body?.cancel().catch(() => {});
        return Response.json(
          { error: "Too many large request bodies in progress" },
          { status: 429, headers: { "Retry-After": "1" } },
        );
      }
      throw error;
    }
    const result = await consume(text, admission);
    if (
      charged > 0 &&
      !retained &&
      result instanceof Response &&
      result.headers.get("content-type")?.startsWith("text/event-stream")
    ) {
      retained = true;
      return retainedStreamingResponse(result, release);
    }
    return result;
  } finally {
    if (!retained) {
      release();
    }
  }
}

/**
 * Ceiling on an uploaded model catalog. The published one is under 100KB;
 * this leaves room for a deployment that declares far more routes than
 * agent-models does, and is still small enough that the JSON a 4xx is
 * decided on was never worth refusing earlier.
 */
export const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;

/** A catalog document an admin uploads, or the response that refuses it. */
export async function catalogBody(request: Request): Promise<unknown | Response> {
  return boundedBody(request, MAX_CATALOG_BODY_BYTES);
}

async function boundedBody(
  request: Request,
  maxBytes: number,
  options: { empty?: unknown } = {},
): Promise<unknown | Response> {
  try {
    const text = await readBodyText(request, maxBytes);
    if (text.trim() === "" && Object.hasOwn(options, "empty")) {
      return options.empty;
    }
    return JSON.parse(text);
  } catch (error) {
    return error instanceof BodyTooLargeError
      ? bodyTooLarge(error)
      : Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
}

export { BodyTooLargeError };
