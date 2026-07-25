import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelParams,
  ChannelToolCall,
  LlmChannel,
} from "@/domain/llm/channel";

/** A channel that replays one scripted chunk list per successive call. */
export class FakeChannel implements LlmChannel {
  calls = 0;
  readonly seenParams: ChannelParams[] = [];

  constructor(private readonly scripts: ChannelChunk[][]) {}

  async chatCompletion(params: ChannelParams): Promise<ChannelCompletion> {
    this.seenParams.push(params);
    const script = this.scripts[this.calls++] ?? [];
    let content = "";
    let toolCalls: ChannelToolCall[] | undefined;
    let usage = null;
    for (const chunk of script) {
      if (chunk.usage) {
        usage = chunk.usage;
      }
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        content += delta.content;
      }
      if (delta?.tool_calls) {
        toolCalls = [...(toolCalls ?? []), ...delta.tool_calls];
      }
    }
    return {
      choices: [{ message: { role: "assistant", content: content || null, tool_calls: toolCalls } }],
      usage,
    };
  }

  async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
    this.seenParams.push(params);
    const script = this.scripts[this.calls++] ?? [];
    for (const chunk of script) {
      yield chunk;
    }
  }
}

export function contentChunk(text: string): ChannelChunk {
  return { choices: [{ delta: { content: text } }] };
}

export function toolCallChunk(
  index: number,
  id: string,
  name: string,
  args: string,
): ChannelChunk {
  return {
    choices: [
      { delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] } },
    ],
  };
}

/** A streaming continuation fragment for an in-progress tool call: only appended
 * argument text, no id/name (they arrived in an earlier fragment). */
export function toolCallArgsChunk(index: number, args: string): ChannelChunk {
  return {
    choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] } }],
  };
}

/**
 * One delta carrying text (or reasoning) AND a tool call together — the shape
 * OpenAI-compatible gateways and reasoning shims emit. The engine must treat
 * the delta fields as concurrent buffers, never as mutually exclusive events.
 */
export function mergedDeltaChunk(
  text: { content?: string; reasoningContent?: string },
  toolCall: { index: number; id: string; name: string; args: string },
): ChannelChunk {
  return {
    choices: [
      {
        delta: {
          content: text.content ?? null,
          reasoning_content: text.reasoningContent ?? null,
          tool_calls: [
            {
              index: toolCall.index,
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.args },
            },
          ],
        },
      },
    ],
  };
}

export function usageChunk(promptTokens: number, completionTokens: number): ChannelChunk {
  return {
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}
