/**
 * Standalone mock OpenAI-compatible server for local development without a
 * real LLM provider. Responds to POST {base}/chat/completions in both stream
 * and non-stream modes; requests a Skill tool call once when tools are offered
 * and the version mentions a skill, then answers.
 *
 *   pnpm tsx scripts/mock-llm.ts   # listens on 127.0.0.1:8002
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8002);

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as {
      stream?: boolean;
      tools?: unknown[];
      messages: Array<{ role: string; content?: unknown }>;
    };
    const hasToolResult = body.messages.some((m) => m.role === "tool");
    const skillName = /skill named "?([a-z0-9-]+)/i.exec(JSON.stringify(body.messages))?.[1];
    const wantsSkill = Boolean(!hasToolResult && body.tools?.length && skillName);
    const answer = `mock answer to: ${String(body.messages.at(-1)?.content ?? "").slice(0, 80)}`;

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
        for (const piece of answer.match(/.{1,12}/g) ?? []) {
          send({ choices: [{ delta: { content: piece }, finish_reason: null }] });
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
