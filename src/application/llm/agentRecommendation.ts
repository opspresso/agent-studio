import { UpstreamError, ValidationError } from "@/application/errors";
import type { ChoiceDecision, DecisionModel } from "@/domain/llm/decision";

export type RecommendationSurface = "chat" | "workspace";
export interface AgentCandidate {
  name: string;
  displayName: string;
  description: string;
}
export interface AgentRecommendation {
  name: string;
  confidence: number;
}

// One option is reserved for a request none of the available Agents can serve.
const MAX_AGENTS_PER_CHOICE = 254;
const MAX_REQUEST_LENGTH = 4_000;
const MAX_DESCRIPTION_LENGTH = 500;

export interface AgentRecommendationDeps {
  decision: DecisionModel;
  selectedModel(): Promise<string | undefined>;
  candidates(surface: RecommendationSurface, userEmail: string): Promise<AgentCandidate[]>;
}

function candidateDescription(candidate: AgentCandidate): string {
  return `${candidate.displayName}: ${candidate.description.slice(0, MAX_DESCRIPTION_LENGTH) || "No description provided"}`;
}

/** All candidate identifiers are assigned here, never inferred from model output. */
async function chooseFrom(
  decision: DecisionModel,
  model: string,
  request: string,
  candidates: AgentCandidate[],
): Promise<{ candidate: AgentCandidate; confidence: number } | undefined> {
  const options = new Map(candidates.map((candidate, index) => [`agent_${index}`, candidate]));
  const criteria = Object.fromEntries([
    ...[...options].map(([key, candidate]) => [key, candidateDescription(candidate)]),
    ["none", "None of these Agents is suitable for this request"],
  ]);
  let answer: ChoiceDecision;
  try {
    answer = await decision.choose({
      model,
      state: request,
      instructions: "Which Agent is best suited to handle the user's request? Choose none if no Agent matches. Base the choice on each Agent's described purpose and capabilities.",
      criteria,
    });
  } catch (error) {
    throw new UpstreamError(error instanceof Error ? error.message : "Decision provider failed");
  }
  if (answer.choice === "none") return undefined;
  const candidate = options.get(answer.choice);
  if (!candidate) throw new UpstreamError("Decision model selected an unknown Agent option");
  return { candidate, confidence: answer.confidence };
}

/** Suggestion only: a person chooses whether to use the result. */
export function createAgentRecommendationUseCases(deps: AgentRecommendationDeps) {
  return {
    async recommend(surface: RecommendationSurface, userEmail: string, request: string): Promise<AgentRecommendation | null> {
      const text = request.trim();
      if (!text || text.length > MAX_REQUEST_LENGTH) throw new ValidationError(`Request must contain 1 to ${MAX_REQUEST_LENGTH} characters`);
      const model = await deps.selectedModel();
      if (!model) return null;
      const candidates = await deps.candidates(surface, userEmail);
      if (candidates.length === 0) return null;
      // TypeSafe Choice accepts at most 255 options. For larger installations,
      // compare one winner from each complete batch in a final Choice.
      const finalists: Array<{ candidate: AgentCandidate; confidence: number }> = [];
      for (let start = 0; start < candidates.length; start += MAX_AGENTS_PER_CHOICE) {
        const result = await chooseFrom(deps.decision, model, text, candidates.slice(start, start + MAX_AGENTS_PER_CHOICE));
        if (result) finalists.push(result);
      }
      if (finalists.length === 0) return null;
      const result = candidates.length <= MAX_AGENTS_PER_CHOICE
        ? finalists[0]
        : finalists.length === 1
          ? finalists[0]
          : await chooseFrom(deps.decision, model, text, finalists.map(item => item.candidate));
      return result ? { name: result.candidate.name, confidence: result.confidence } : null;
    },
  };
}
