export interface Skill {
  name: string;
  description: string;
  content: string;
  /** Provenance marker for synced skills, e.g. "github:opspresso/agent-skills". */
  source?: string;
  createdAt: string;
  updatedAt: string;
}
