import { RateLimitedError, UpstreamError, ValidationError } from "@/application/errors";
import { MAX_CHOICE_OPTIONS, type AgentRecommendationQuota, type ChoiceDecision, type DecisionModel } from "@/domain/llm/decision";
import { PiiFilter } from "@/application/llm/pii";

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
// Keep the criteria well inside Jev's context even when names/descriptions use
// token-dense scripts. The protocol permits 255 options, but that is not a
// useful batch size when each Agent needs a meaningful description.
const MAX_AGENTS_PER_CHOICE = Math.min(MAX_CHOICE_OPTIONS - 1, 64);
export const MAX_AGENT_RECOMMENDATION_REQUEST_LENGTH = 4_000;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_DISPLAY_NAME_LENGTH = 100;

export interface AgentRecommendationDeps {
  decision: DecisionModel;
  quota: AgentRecommendationQuota;
  selectedModel(): Promise<string | undefined>;
  candidates(surface: RecommendationSurface, userEmail: string): Promise<AgentCandidate[]>;
}

function candidateDescription(candidate: AgentCandidate): string {
  return `${candidate.displayName.slice(0, MAX_DISPLAY_NAME_LENGTH)}: ${candidate.description.slice(0, MAX_DESCRIPTION_LENGTH) || "No description provided"}`;
}

/** All candidate identifiers are assigned here, never inferred from model output. */
async function chooseFrom(
  decision: DecisionModel,
  model: string,
  request: string,
  candidates: AgentCandidate[],
  pii: PiiFilter,
  signal?: AbortSignal,
): Promise<{ candidate: AgentCandidate; confidence: number } | undefined> {
  const options = new Map(candidates.map((candidate, index) => [`agent_${index}`, candidate]));
  const criteria = Object.fromEntries([
    ...[...options].map(([key, candidate]) => [key, pii.mask(candidateDescription(candidate))]),
    ["none", "None of these Agents is suitable for this request"],
  ]);
  let answer: ChoiceDecision;
  try {
    answer = await decision.choose({
      model,
      state: request,
      instructions: "Which Agent is best suited to handle the user's request? Choose none if no Agent matches. Base the choice on each Agent's described purpose and capabilities.",
      criteria,
      signal,
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
    async recommend(surface: RecommendationSurface, userEmail: string, request: string, signal?: AbortSignal): Promise<AgentRecommendation | null> {
      const text = request.trim();
      if (!text || text.length > MAX_AGENT_RECOMMENDATION_REQUEST_LENGTH) throw new ValidationError(`Request must contain 1 to ${MAX_AGENT_RECOMMENDATION_REQUEST_LENGTH} characters`);
      const model = await deps.selectedModel();
      if (!model) return null;
      const candidates = await deps.candidates(surface, userEmail);
      if (candidates.length === 0) return null;
      const retryAfterSeconds = await deps.quota.admit(userEmail);
      if (retryAfterSeconds !== undefined) {
        throw new RateLimitedError("Too many Agent recommendation requests", retryAfterSeconds);
      }
      // No Agent has been chosen yet, so no Agent-specific piiFiltering setting
      // can guard this call. Mask the request and candidate descriptions before
      // sending either to the configured decision provider.
      const pii = new PiiFilter();
      const maskedRequest = pii.mask(text);
      // Each round reduces a complete roster to its batch winners. Repeating
      // the same rule also bounds an installation larger than one final batch.
      let round = candidates;
      for (;;) {
        const winners: Array<{ candidate: AgentCandidate; confidence: number }> = [];
        for (let start = 0; start < round.length; start += MAX_AGENTS_PER_CHOICE) {
          const result = await chooseFrom(deps.decision, model, maskedRequest, round.slice(start, start + MAX_AGENTS_PER_CHOICE), pii, signal);
          if (result) winners.push(result);
        }
        if (winners.length === 0) return null;
        if (round.length <= MAX_AGENTS_PER_CHOICE || winners.length === 1) {
          const winner = winners[0]!;
          return { name: winner.candidate.name, confidence: winner.confidence };
        }
        round = winners.map(item => item.candidate);
      }
    },
  };
}
