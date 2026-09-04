import { afterEach, describe, expect, it, vi } from "vitest";
import {
  editorBody,
  LARGE_TURN_BODY_BYTES,
  MAX_CONCURRENT_LARGE_TURN_BYTES,
  MAX_TURN_BODY_BYTES,
  setTurnBodyBudgetBytes,
  withTurnBody,
} from "@/app/api/_lib/body";
import { MAX_INBOUND_EVENT_BYTES, readEventBody } from "@/app/api/_lib/inboundEvent";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "@/domain/llm/documentLimits";

/**
 * `body.ts` already said why an unbounded body is a problem — "several hundred
 * megabytes of resident memory per request, from any signed-in caller, before a
 * single validator has looked at it" — and then only the chat routes asked for
 * the bound. `/predict` took the same attachments through `request.json()`, so
 * its `attachedImagesSchema` checked the size once the string was resident.
 */
function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://x.test/api/thing", { method: "POST", body, headers });
}

function parseTurn(request: Request): Promise<unknown | Response> {
  return withTurnBody(request, async (body) => body);
}

function largeTurnBody(): string {
  return JSON.stringify({ pad: "a".repeat(LARGE_TURN_BODY_BYTES) });
}

/**
 * The budget shrunk to hold two of these bodies, so the refusal below is
 * reached without allocating the hundred and sixty megabytes the real budget is
 * worth. What is being tested is the accounting, not the number.
 */
function budgetForTwoLargeBodies(): void {
  setTurnBodyBudgetBytes(2 * largeTurnBody().length);
}

describe("withTurnBody", () => {
  afterEach(() => {
    setTurnBodyBudgetBytes();
  });

  it("parses a body within the cap", async () => {
    expect(await parseTurn(post(JSON.stringify({ prompt: "hi" })))).toEqual({ prompt: "hi" });
  });

  it("refuses one over it with a 413 rather than parsing it", async () => {
    const oversized = JSON.stringify({ pad: "a".repeat(MAX_TURN_BODY_BYTES) });

    const result = await parseTurn(post(oversized));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("answers a malformed body with 400, not 413", async () => {
    // The two are different problems and a caller acts differently on each.
    const result = await parseTurn(post("{not json"));

    expect((result as Response).status).toBe(400);
  });

  it("leaves room for every attachment a turn may legally carry", async () => {
    // The cap is derived, so this pins the derivation rather than a number: a
    // request at the documented limits must not be refused by the body reader.
    const attachments =
      MAX_DOCUMENT_BYTES * MAX_DOCUMENTS + MAX_IMAGE_BYTES * MAX_IMAGES_PER_TURN;

    expect(MAX_TURN_BODY_BYTES).toBeGreaterThan(attachments);
  });

  it("charges bytes rather than requests, so a small attachment is not a whole permit", async () => {
    // The budget is worth two maximal turns. A body just past the prose
    // allowance is a three-hundredth of one, and would spend the same permit
    // — two screenshots in flight 429'd everyone else for the length of a run.
    const largeBody = largeTurnBody();

    expect(MAX_CONCURRENT_LARGE_TURN_BYTES).toBe(2 * MAX_TURN_BODY_BYTES);
    expect(Math.floor(MAX_CONCURRENT_LARGE_TURN_BYTES / largeBody.length)).toBeGreaterThan(100);

    let releaseConsumers = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseConsumers = resolve;
    });
    let started = 0;
    const concurrent = 8;
    const pending = Array.from({ length: concurrent }, () =>
      withTurnBody(post(largeBody), async (body) => {
        started += 1;
        await held;
        return body;
      }),
    );
    await vi.waitFor(() => expect(started).toBe(concurrent));

    releaseConsumers();
    await Promise.all(pending);
  });

  it("refuses a body the budget cannot hold and releases what it charged", async () => {
    budgetForTwoLargeBodies();
    let releaseConsumers = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseConsumers = resolve;
    });
    let started = 0;
    const largeBody = largeTurnBody();
    const pending = Array.from({ length: 2 }, () =>
      withTurnBody(post(largeBody), async (body) => {
        started += 1;
        await held;
        return body;
      }),
    );
    await vi.waitFor(() => expect(started).toBe(2));

    await expect(parseTurn(post('{"prompt":"small requests remain available"}'))).resolves.toEqual({
      prompt: "small requests remain available",
    });

    let refusedBodyCancelled = false;
    const refused = await parseTurn(
      new Request("https://x.test/api/thing", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(largeBody));
          },
          cancel() {
            refusedBodyCancelled = true;
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(429);
    expect((refused as Response).headers.get("retry-after")).toBe("1");
    expect(refusedBodyCancelled).toBe(true);

    releaseConsumers();
    await Promise.all(pending);
    await expect(parseTurn(post('{"prompt":"after"}'))).resolves.toEqual({ prompt: "after" });
  });

  it("retains a large body's charge until streamed responses close or cancel", async () => {
    budgetForTwoLargeBodies();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        withTurnBody(
          post(largeTurnBody()),
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controllers.push(controller);
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            ),
        ),
      ),
    );

    const refused = await parseTurn(post(largeTurnBody()));
    expect((refused as Response).status).toBe(429);

    const first = (responses[0]! as Response).text();
    controllers[0]!.close();
    await first;
    await (responses[1]! as Response).body?.cancel();

    await expect(parseTurn(post(largeTurnBody()))).resolves.toEqual({
      pad: "a".repeat(LARGE_TURN_BODY_BYTES),
    });
  });

  it("releases a detached-work charge when retained work rejects", async () => {
    budgetForTwoLargeBodies();
    let rejectWork = (_error: Error): void => {};
    const work = new Promise<void>((_resolve, reject) => {
      rejectWork = reject;
    });
    await withTurnBody(post(largeTurnBody()), async (_body, admission) => {
      admission.retainUntil(work);
      return Response.json({ accepted: true });
    });

    rejectWork(new Error("detached run failed"));
    await Promise.resolve();
    await expect(parseTurn(post(largeTurnBody()))).resolves.toEqual({
      pad: "a".repeat(LARGE_TURN_BODY_BYTES),
    });
  });
});

describe("editorBody", () => {
  it("is orders of magnitude tighter than a turn's", async () => {
    // Nothing typed into the console approaches four 10MB attachments, and a
    // registry route that accepted one would be a memory sink with no feature
    // behind it.
    const result = await editorBody(post(JSON.stringify({ pad: "a".repeat(2 * 1024 * 1024) })));

    expect((result as Response).status).toBe(413);
  });

  it("still takes a skill's whole file set", async () => {
    // The bound is derived from exactly this, so a skill at its documented
    // limit has to survive the reader that protects it.
    const files = { files: [{ path: "a.md", content: "x".repeat(180 * 1024) }] };

    expect(await editorBody(post(JSON.stringify(files)))).toEqual(files);
  });

  it("uses an explicit empty-body value without accepting malformed JSON as empty", async () => {
    await expect(editorBody(post(""), { empty: {} })).resolves.toEqual({});

    const malformed = await editorBody(post("{"), { empty: {} });
    expect((malformed as Response).status).toBe(400);
  });
});

describe("readEventBody", () => {
  it("hands back a delivery within the cap", async () => {
    expect(await readEventBody(post('{"type":"event_callback"}'))).toBe('{"type":"event_callback"}');
  });

  it("refuses one over it with a 413 that names the bound", async () => {
    // Four webhooks — Slack, Telegram, Teams and a project's own — each named
    // their own megabyte and then wrote a flat "Request body too large", the
    // only 413 on the platform that did not say what the limit was. A caller
    // that cannot read the bound out of the refusal learns it from a 500.
    const result = await readEventBody(post("a".repeat(MAX_INBOUND_EVENT_BYTES + 1)));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    await expect((result as Response).json()).resolves.toEqual({
      error: `HTTP body exceeds ${MAX_INBOUND_EVENT_BYTES} bytes`,
    });
  });

  it("leaves parsing to the caller, so a malformed body is not its refusal", async () => {
    // Each platform reads its own payload shape and answers 400 in its own
    // vocabulary; this only decides how much may be read.
    expect(await readEventBody(post("{not json"))).toBe("{not json");
  });
});
