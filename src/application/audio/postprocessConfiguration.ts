import type { Project } from "@/domain/project/types";
import { getModelConfig } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";

/** A queued job pins current settings once; retries never reselect an Agent. */
export async function resolveAudioPostprocessor(
  authorize: (name: string, email: string) => Promise<Project>,
  reference: { projectName: string },
  email: string,
) {
  const project = await authorize(reference.projectName, email);
  const configuration = project.configuration;
  if (!configuration) throw new ValidationError(`Postprocessing Agent "${project.name}" is not configured`);
  if (!getModelConfig(configuration.model)?.capabilities.structuredOutput) {
    throw new ValidationError(`Postprocessing model "${configuration.model}" does not support structured output`);
  }
  return { projectName: project.name, configuration: structuredClone(configuration) };
}
