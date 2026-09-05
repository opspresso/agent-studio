/**
 * Standalone mock OpenAI-compatible server for local development without a
 * real LLM provider. Responds to POST {base}/chat/completions in both stream
 * and non-stream modes; requests a Skill tool call once when tools are offered
 * and the version mentions a skill, then answers.
 *
 *   pnpm tsx scripts/mock-llm.ts   # listens on 127.0.0.1:8002
 *
 * Two knobs for looking at a chat window rather than testing a run. The
 * defaults reproduce the old behaviour exactly — one short answer, every chunk
 * at once — because the integration check wants an answer, not a performance:
 *
 *   MOCK_LLM_CHUNKS=400 MOCK_LLM_DELAY_MS=40 pnpm tsx scripts/mock-llm.ts
 *
 * Nothing about a scrolling, streaming reply can be reproduced by an answer
 * that arrives complete before the first paint.
 */
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8002);
/** Milliseconds between streamed chunks. 0 sends them as fast as the socket takes. */
const DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS ?? 0);
/** Roughly how many chunks the answer is padded to. 0 keeps the one-line answer. */
const CHUNKS = Number(process.env.MOCK_LLM_CHUNKS ?? 0);
/** What `.match(/.{1,12}/g)` below cuts the answer into. */
const CHUNK_CHARS = 12;

const SENTENCES = [
  "A chat run outlives the connection that started it, so hanging up means the reader left rather than stop.",
  "What streamed is persisted either way, and whoever comes back can pick the answer up from where it got to.",
  "The replay log is a buffer rather than a record: it is written only once the reader is gone.",
  "Ordering is the whole contract — persist, then the terminal entry, then release the lease.",
];

/**
 * A long answer with the shapes a real one has: headings, prose, a fenced code
 * block and a list. The code fence matters — a block that opens and closes
 * mid-stream is where a chat window's layout is most likely to jump.
 */
function longAnswer(targetChars: number): string {
  const lines: string[] = ["# A deliberately long answer", ""];
  let length = 0;
  for (let section = 1; length < targetChars; section += 1) {
    lines.push(`## Section ${section}`, "");
    for (const sentence of SENTENCES) {
      lines.push(`${sentence} ${SENTENCES[section % SENTENCES.length]}`, "");
    }
    lines.push(
      "```ts",
      `export const section${section} = {`,
      `  index: ${section},`,
      `  note: "written a character at a time, like everything else here",`,
      "};",
      "```",
      "",
      `- the first point of section ${section}`,
      `- the second point of section ${section}`,
      "",
    );
    length = lines.reduce((total, line) => total + line.length + 1, 0);
  }
  return lines.join("\n");
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    // A bad body must answer 400, not throw: this callback is async, so a
    // throw here is an unhandled rejection that takes the whole server down.
    let body: {
      stream?: boolean;
      tools?: unknown[];
      messages: Array<{ role: string; content?: unknown }>;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!body || !Array.isArray(body.messages) || body.messages.some(
      (message) => !message || typeof message !== "object" || typeof message.role !== "string",
    )) {
      res.writeHead(400).end();
      return;
    }
    const hasToolResult = body.messages.some((m) => m.role === "tool");
    const skillName = /skill named "?([a-z0-9-]+)/i.exec(JSON.stringify(body.messages))?.[1];
    const wantsSkill = Boolean(!hasToolResult && body.tools?.length && skillName);
    const asked = `mock answer to: ${String(body.messages.at(-1)?.content ?? "").slice(0, 80)}`;
    const answer =
      CHUNKS > 0 ? `${asked}\n\n${longAnswer(CHUNKS * CHUNK_CHARS)}` : asked;

    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (wantsSkill) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${Date.now()}`,
                    type: "function",
                    function: { name: "Skill", arguments: JSON.stringify({ name: skillName }) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      } else {
        for (const piece of answer.match(/.{1,12}/gs) ?? []) {
          // The reader closing the tab is a thing this server is now used to
          // demonstrate, so stop writing into a socket that has gone.
          if (res.destroyed) {
            return;
          }
          send({ choices: [{ delta: { content: piece }, finish_reason: null }] });
          if (DELAY_MS > 0) {
            await delay(DELAY_MS);
          }
        }
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } });
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `cmpl-${Date.now()}`,
          choices: [
            { message: { role: "assistant", content: answer }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      );
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock LLM listening on http://127.0.0.1:${PORT}/v1`);
});
