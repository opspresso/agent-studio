import type { Project } from "./types";

export function projectHasAudioTools(project: Pick<Project, "configuration">): boolean {
  return project.configuration?.parameters.audioProcessing === true;
}
