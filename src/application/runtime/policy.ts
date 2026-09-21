import { InputGuardrailTripwireTriggered, withGuardrailSpan, defineToolInputGuardrail, ToolGuardrailFunctionOutputFactory, type InputGuardrail, type Agent, type AgentOutputType, type RunContext } from "@openai/agents";
import type { RuntimePolicy } from "@/domain/execution/runtimeSession";
import { messageText, type ChatMessageInput } from "@/domain/llm/types";
import { toAgentInput, restoreValues } from "./messages";
import type { PiiFilter } from "@/application/llm/pii";

export function inputGuardrails(messages: ChatMessageInput[], policy?: RuntimePolicy, filter?: PiiFilter): InputGuardrail[] {
  const limit = policy?.maxInputChars;
  if (!limit) return [];
  return [{ name: "input-size", runInParallel: false, execute: async () => ({
    tripwireTriggered: messages.reduce((size, message) => size + (filter?.restore(messageText(message)) ?? messageText(message)).length, 0) > limit,
    outputInfo: { reason: "Input exceeds the Agent's policy limit" },
  }) }];
}

/** Native validation also runs before approval, including frontend tool interruptions. */
export function toolInputGuardrail(validate: (input: unknown) => void, filter?: PiiFilter) {
  return defineToolInputGuardrail({ name: "tool-schema", run: async ({ toolCall }) => {
    try {
      const input: unknown = JSON.parse(toolCall.arguments);
      validate(filter ? restoreValues(filter, input) : input);
      return ToolGuardrailFunctionOutputFactory.allow();
    } catch (error) {
      return ToolGuardrailFunctionOutputFactory.rejectContent(error instanceof Error ? error.message : "Invalid tool arguments");
    }
  } });
}

/** Runner checks input guardrails on the starting agent, so a handoff checks its target explicitly. */
export async function checkHandoffInput(agent: Agent<unknown, AgentOutputType>, messages: ChatMessageInput[], context: RunContext<unknown>): Promise<void> {
  for (const guardrail of agent.inputGuardrails) {
    await withGuardrailSpan(async (span) => {
      const output = await guardrail.execute({ agent, input: toAgentInput(messages), context });
      span.spanData.triggered = output.tripwireTriggered;
      if (output.tripwireTriggered) throw new InputGuardrailTripwireTriggered(`Input guardrail '${guardrail.name}' triggered`, {
        guardrail: { type: "input", name: guardrail.name }, output,
      });
    }, { data: { name: guardrail.name } });
  }
}
