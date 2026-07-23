import { describe, expect, it } from "vitest";
import { runAgent, runPrompt, runPromptStream } from "@/application/llm/engine";
import { PiiFilter } from "@/application/llm/pii";
import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelParams,
  LlmChannel,
} from "@/domain/llm/channel";
import type { EngineChunk } from "@/domain/llm/types";

class EchoChannel implements LlmChannel {
  readonly seenParams: ChannelParams[] = [];

  async chatCompletion(params: ChannelParams): Promise<ChannelCompletion> {
    this.seenParams.push(params);
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: `Contact ${params.messages.at(-1)?.content ?? ""}`,
          },
        },
      ],
    };
  }

  async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
    this.seenParams.push(params);
    const content = `Contact ${params.messages.at(-1)?.content ?? ""}`;
    for (const char of content) {
      yield { choices: [{ delta: { content: char } }] };
    }
  }
}

class ErrorChannel implements LlmChannel {
  readonly seenParams: ChannelParams[] = [];
  emitted = "";

  async chatCompletion(): Promise<ChannelCompletion> {
    throw new Error("not used");
  }

  async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
    this.seenParams.push(params);
    this.emitted = String(params.messages.at(-1)?.content).slice(0, 5);
    yield { choices: [{ delta: { content: this.emitted } }] };
    throw new Error("stream failed");
  }
}

class TransferChannel implements LlmChannel {
  readonly seenParams: ChannelParams[] = [];

  async chatCompletion(): Promise<ChannelCompletion> {
    throw new Error("not used");
  }

  async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
    this.seenParams.push(params);
    if (this.seenParams.length === 1) {
      const message = String(params.messages.at(-1)?.content);
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "transfer_to_agent",
                    arguments: JSON.stringify({ agent_name: "child", message }),
                  },
                },
              ],
            },
          },
        ],
      };
      return;
    }
    yield { choices: [{ delta: { content: "Done." } }] };
  }
}

async function collectText(source: AsyncGenerator<EngineChunk>): Promise<string> {
  let text = "";
  for await (const chunk of source) {
    text += chunk.delta?.content ?? "";
  }
  return text;
}

describe("PiiFilter", () => {
  it("replaces email and phone values while preserving their format", () => {
    const filter = new PiiFilter();
    const original = "user.12@example.com / +82 10-1234-5678";

    const masked = filter.mask(original);

    expect(masked).not.toContain("user.12@example.com");
    expect(masked).not.toContain("+82 10-1234-5678");
    expect(masked).toMatch(/^[a-z]{4}\.\d{2}@[a-z]{7}\.[a-z]{3} \/ \+\d{2} \d{2}-\d{4}-\d{4}$/);
    expect(filter.restore(masked)).toBe(original);
    expect(filter.mask(original)).toBe(masked);
  });

  it("masks the prompt before a non-streaming call and restores the response", async () => {
    const channel = new EchoChannel();
    const input = "email@example.com, 010-1234-5678";

    const result = await runPrompt(
      { channel },
      {
        model: "test/model",
        userPromptTemplate: input,
        parameters: { piiFiltering: true },
      },
    );

    const sent = String(channel.seenParams[0]?.messages[0]?.content);
    expect(sent).not.toContain("email@example.com");
    expect(sent).not.toContain("010-1234-5678");
    expect(result.content).toBe(`Contact ${input}`);
  });

  it("restores replacements split across streaming chunk boundaries", async () => {
    const channel = new EchoChannel();
    const input = "email@example.com, 010-1234-5678";

    const result = await collectText(
      runPromptStream(
        { channel },
        {
          model: "test/model",
          userPromptTemplate: input,
          parameters: { piiFiltering: true },
        },
      ),
    );

    expect(result).toBe(`Contact ${input}`);
  });

  it("masks and restores an agent stream across its internal message history", async () => {
    const channel = new EchoChannel();
    const input = "email@example.com, 010-1234-5678";

    const result = await collectText(
      runAgent(
        { channel },
        {
          projectName: "test",
          model: "test/model",
          messages: [{ role: "user", content: input }],
          parameters: { piiFiltering: true },
        },
      ),
    );

    const sent = String(channel.seenParams[0]?.messages[0]?.content);
    expect(sent).not.toContain("email@example.com");
    expect(sent).not.toContain("010-1234-5678");
    expect(result).toBe(`Contact ${input}`);
  });

  it("keeps PII masked across a subagent boundary and restores child chunks", async () => {
    const channel = new TransferChannel();
    const input = "email@example.com or 010-1234-5678";
    let childMessage = "";
    const runSubagent = async function* (agentName: string, message: string) {
      childMessage = message;
      for (const char of message) {
        yield { author: agentName, delta: { content: char } };
      }
      return message;
    };

    const result = await collectText(
      runAgent(
        { channel, runSubagent },
        {
          projectName: "parent",
          model: "test/model",
          messages: [{ role: "user", content: input }],
          parameters: { piiFiltering: true },
          subagents: [{ name: "child", description: "", type: "remote" }],
          maxTurn: 3,
        },
      ),
    );

    expect(childMessage).not.toContain("email@example.com");
    expect(childMessage).not.toContain("010-1234-5678");
    expect(result).toContain(input);
    expect(result).toContain("Done.");
  });

  it("flushes buffered text before reporting a streaming error", async () => {
    const channel = new ErrorChannel();
    const chunks: EngineChunk[] = [];

    for await (const chunk of runPromptStream(
      { channel },
      {
        model: "test/model",
        userPromptTemplate: "email@example.com",
        parameters: { piiFiltering: true },
      },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.delta?.content ?? "").join("")).toBe(channel.emitted);
    expect(chunks.at(-1)?.error).toBe("stream failed");
  });

  it("leaves the existing request and response bytes unchanged when disabled", async () => {
    const channel = new EchoChannel();
    const input = "email@example.com, 010-1234-5678";

    const result = await collectText(
      runPromptStream(
        { channel },
        {
          model: "test/model",
          userPromptTemplate: input,
          parameters: { piiFiltering: false },
        },
      ),
    );

    expect(channel.seenParams[0]?.messages[0]?.content).toBe(input);
    expect(result).toBe(`Contact ${input}`);
  });
});
