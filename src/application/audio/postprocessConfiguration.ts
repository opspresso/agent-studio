import type { Agent } from "@/domain/agent/types";
import { getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";

/** A queued job pins current settings once; retries never reselect an Agent. */
export async function resolveAudioPostprocessor(
  authorize: (name: string, email: string) => Promise<Agent>,
  reference: { agentName: string },
  email: string,
) {
  const agent = await authorize(reference.agentName, email);
  const configuration = agent.configuration;
  if (!configuration) throw new ValidationError(`Postprocessing Agent "${agent.name}" is not configured`);
  if (!getModelConfig(configuration.model)?.capabilities.structuredOutput) {
    throw new ValidationError(`Postprocessing model "${configuration.model}" does not support structured output`);
  }
  return { agentName: agent.name, configuration: structuredClone(configuration) };
}
