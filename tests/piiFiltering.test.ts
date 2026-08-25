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

/**
 * Same shape as {@link TransferChannel} but fanning out. The model quotes back
 * what it was shown — which is masked — because that is what a real one does, and
 * it is the only way a restored copy of the message can be told apart from the
 * masked original once it reaches the child.
 */
class DispatchChannel implements LlmChannel {
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
                    name: "dispatch_agents",
                    arguments: JSON.stringify({ tasks: [{ agent_name: "child", message }] }),
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

class ImageToolChannel implements LlmChannel {
  readonly seenParams: ChannelParams[] = [];

  async chatCompletion(): Promise<ChannelCompletion> {
    throw new Error("not used");
  }

  async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
    this.seenParams.push(params);
    if (this.seenParams.length === 1) {
      const prompt = String(params.messages.at(-1)?.content);
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
                    name: "GenerateImage",
                    arguments: JSON.stringify({ prompt }),
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
    expect(masked).toMatch(
      /^\[\[PII:[a-z]{4}\.\d{2}@[a-z]{7}\.[a-z]{3}\]\] \/ \[\[PII:\+\d{2} \d{2}-\d{4}-\d{4}\]\]$/,
    );
    expect(filter.restore(masked)).toBe(original);
    expect(filter.mask(original)).toBe(masked);
  });

  it("replaces Korean registration numbers while preserving their format", () => {
    const filter = new PiiFilter();
    const original = "주민등록번호 900101-1234567 입니다";

    const masked = filter.mask(original);

    expect(masked).not.toContain("900101-1234567");
    expect(masked).toMatch(/^주민등록번호 \[\[PII:\d{6}-\d{7}\]\] 입니다$/);
    expect(filter.restore(masked)).toBe(original);
    expect(filter.mask(original)).toBe(masked);
  });

  it("leaves what only looks like a registration number alone", () => {
    const filter = new PiiFilter();
    // Month 13, day 32, a 7th digit outside 1-8, and the bare 13-digit form.
    for (const value of [
      "991301-1234567",
      "900132-1234567",
      "900101-9234567",
      "9001011234567",
    ]) {
      expect(filter.mask(value)).toBe(value);
    }
  });

  it("replaces card numbers whole, whatever the separator", () => {
    const filter = new PiiFilter();
    for (const original of [
      "4111-1111-1111-1111",
      "4111 1111 1111 1111",
      "4111.1111.1111.1111",
      "4111111111111111",
    ]) {
      const masked = filter.mask(original);
      // The phone pattern used to partially match the separated forms and leave
      // the last group in the clear — the card entity must take the whole value.
      expect(masked).toMatch(/^\[\[PII:[\d .-]{16,19}\]\]$/);
      expect(filter.restore(masked)).toBe(original);
    }
  });

  it("masks the card and leaves a suffix bolted onto it", () => {
    const filter = new PiiFilter();
    const original = "invoice 4111-1111-1111-1111-01";

    const masked = filter.mask(original);

    expect(masked).toMatch(/^invoice \[\[PII:\d{4}-\d{4}-\d{4}-\d{4}\]\]-01$/);
    expect(filter.restore(masked)).toBe(original);
  });

  it("keeps the phone-shaped partial mask when a card-shaped run fails Luhn", () => {
    const filter = new PiiFilter();
    const original = "mistyped card 4111 1111 1111 1112 end";

    const masked = filter.mask(original);

    // The card branch must not swallow the span and return it untouched: the
    // phone branch masked `4111 1111 1111` before the card branch existed, and
    // a number one typo away from a real card deserves no less.
    expect(masked).toMatch(/^mistyped card \[\[PII:\d{4} \d{4} \d{4}\]\] 1112 end$/);
    expect(filter.restore(masked)).toBe(original);
    expect(filter.mask(original)).toBe(masked);
  });

  it("leaves a bare digit run that fails Luhn alone", () => {
    const filter = new PiiFilter();
    // No separators, so the phone fallback has nothing to recognise either.
    const orderId = "4111111111111112";

    expect(filter.mask(orderId)).toBe(orderId);
  });

  it("masks a value inside marker-shaped text this filter never wrote", () => {
    const filter = new PiiFilter();
    // Scanning for `[[PII:` rather than for every entry of the table is what
    // keeps this fast; a span the table does not know is therefore text, not a
    // token, and the value inside it has to be masked like any other.
    const masked = filter.mask("[[PII:a@b.co]] and [[PII: unterminated");

    expect(masked).not.toContain("a@b.co");
    expect(masked).toContain("[[PII: unterminated");
  });

  it("restores a stream whatever the mapping's size", () => {
    const filter = new PiiFilter();
    // Every chunk used to be scanned against the whole mapping, twice — so a
    // run that masked a few thousand addresses spent seconds of blocked event
    // loop restoring one turn. The ceiling is far above the linear cost and far
    // below the quadratic one.
    const source = Array.from(
      { length: 4_000 },
      (_, index) => `user${index}@example.com wrote something.`,
    ).join("\n");
    const masked = filter.mask(source);

    const restorer = filter.createStreamRestorer();
    const startedAt = Date.now();
    let restored = "";
    for (let at = 0; at < masked.length; at += 8) {
      restored += restorer.push(masked.slice(at, at + 8));
    }
    restored += restorer.flush();

    expect(restored).toBe(source);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("distinguishes a real value from the contents of an existing placeholder", () => {
    const filter = new PiiFilter();
    const firstMasked = filter.mask("111-111-1111");
    const collidingOriginal = /^\[\[PII:(.*)\]\]$/.exec(firstMasked)?.[1];
    expect(collidingOriginal).toBeDefined();

    const secondMasked = filter.mask(collidingOriginal ?? "");

    expect(secondMasked).not.toBe(collidingOriginal);
    expect(filter.restore(secondMasked)).toBe(collidingOriginal);
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

  it("masks the conversation a transfer carries, not just the message", async () => {
    // The transcript is history the parent's own context already has masked; it
    // crosses the same boundary the message does and must cross it the same way.
    const channel = new TransferChannel();
    let childTranscript: string | undefined;
    const runSubagent = async function* (
      _agentName: string,
      _message: string,
      _turn: number,
      _maxTurn: number,
      _images?: unknown,
      transcript?: string,
    ): AsyncGenerator<EngineChunk, string> {
      childTranscript = transcript;
      return "ok";
    };

    await collectText(
      runAgent(
        { channel, runSubagent },
        {
          projectName: "parent",
          model: "test/model",
          messages: [
            { role: "user", content: "reach me at email@example.com" },
            { role: "assistant", content: "Noted, I will call 010-1234-5678." },
            { role: "user", content: "go ahead" },
          ],
          parameters: { piiFiltering: true },
          subagents: [{ name: "child", description: "", type: "remote" }],
          maxTurn: 3,
        },
      ),
    );

    expect(childTranscript).toBeDefined();
    expect(childTranscript).not.toContain("email@example.com");
    expect(childTranscript).not.toContain("010-1234-5678");
    // Masked, not dropped: the child still sees that a contact was mentioned.
    expect(childTranscript).toContain("reach me at");
    expect(childTranscript).toContain("[[PII:");
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

  it("hands a dispatched child the masked message, exactly as a transfer does", async () => {
    // `displayArgs` has the PII restored, for display and for MCP dispatch. A
    // subagent is the other side of that boundary: taking the message from there
    // would send real addresses to another model while the parent's own context
    // stayed protected.
    const channel = new DispatchChannel();
    const input = "email@example.com or 010-1234-5678";
    const seen: string[] = [];
    const runSubagent = async function* (agentName: string, message: string) {
      seen.push(message);
      yield { author: agentName, delta: { content: message } };
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
          subagents: [{ name: "child", description: "", type: "local" }],
          canDispatch: true,
          maxTurn: 4,
        },
      ),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("email@example.com");
    expect(seen[0]).not.toContain("010-1234-5678");
    expect(seen[0]).toContain("[[PII:");
    // And the parent's own output still restores.
    expect(result).toContain(input);
  });

  it("closes the child generator when the parent stream is cancelled", async () => {
    const channel = new TransferChannel();
    let childClosed = false;
    const runSubagent = async function* () {
      try {
        yield { author: "child", delta: { content: "child output" } };
        await new Promise(() => {});
      } finally {
        childClosed = true;
      }
      return "";
    };
    const source = runAgent(
      { channel, runSubagent },
      {
        projectName: "parent",
        model: "test/model",
        messages: [{ role: "user", content: "email@example.com" }],
        parameters: { piiFiltering: true },
        subagents: [{ name: "child", description: "", type: "remote" }],
        maxTurn: 3,
      },
    );

    while (true) {
      const step = await source.next();
      if (step.done || step.value.delta?.content === "child output") {
        break;
      }
    }
    await source.return(undefined);

    expect(childClosed).toBe(true);
  });

  it("keeps PII masked for image generation while restoring the displayed prompt", async () => {
    const channel = new ImageToolChannel();
    const input = "Draw email@example.com and 010-1234-5678";
    let generatedPrompt = "";
    const chunks: EngineChunk[] = [];

    for await (const chunk of runAgent(
      {
        channel,
        generateImage: async (prompt) => {
          generatedPrompt = prompt;
          return { b64: "aW1n", mimeType: "image/png", model: "openai/gpt-image-1" };
        },
      },
      {
        projectName: "image-agent",
        model: "test/model",
        messages: [{ role: "user", content: input }],
        parameters: { piiFiltering: true },
        maxTurn: 2,
      },
    )) {
      chunks.push(chunk);
    }

    expect(generatedPrompt).not.toContain("email@example.com");
    expect(generatedPrompt).not.toContain("010-1234-5678");
    expect(chunks.find((chunk) => chunk.image)?.image?.prompt).toBe(input);
  });

  it("masks PII from image errors before the next model turn", async () => {
    const channel = new ImageToolChannel();
    const input = "Draw email@example.com";
    const chunks: EngineChunk[] = [];

    for await (const chunk of runAgent(
      {
        channel,
        generateImage: async () => {
          throw new Error("provider rejected email@example.com");
        },
      },
      {
        projectName: "image-agent",
        model: "test/model",
        messages: [{ role: "user", content: input }],
        parameters: { piiFiltering: true },
        maxTurn: 2,
      },
    )) {
      chunks.push(chunk);
    }

    const toolMessage = channel.seenParams[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).not.toContain("email@example.com");
    expect(chunks.find((chunk) => chunk.toolResult)?.toolResult?.content).toContain(
      "email@example.com",
    );
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
