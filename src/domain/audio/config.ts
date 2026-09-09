import type { AudioJobInput } from "./job";

export interface AudioJobConfig extends Pick<AudioJobInput, "model" | "language" | "retention" | "postprocess" | "destination"> {
  projectName: string;
  userEmail: string;
  revision: number;
  enabled: boolean;
  maxActive: number;
  maxPerOccurrence: number;
  updatedAt: string;
}

export interface AudioJobConfigRepository {
  get(projectName: string): Promise<AudioJobConfig | null>;
  save(config: AudioJobConfig, expectedRevision: number): Promise<boolean>;
}
