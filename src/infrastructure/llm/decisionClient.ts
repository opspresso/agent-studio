import type { ChoiceDecision, DecisionModel } from "@/domain/llm/decision";
import type { TargetResolver } from "./providers";

function endpoint(baseUrl: string, provider: string | null): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (provider === "openrouter") {
    const prefix = path.replace(/\/v1$/, "");
    url.pathname = `${prefix}/alpha/decisions`;
  } else if (provider === "selfhosted") {
    url.pathname = `${path}${path.endsWith("/v1") ? "" : "/v1"}/systemone`;
  } else {
    throw new Error("The selected decision model provider does not support decisions");
  }
  return url.href;
}

function choiceAnswer(value: unknown, criteria: Record<string, string>): ChoiceDecision {
  const answer = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const probabilities = answer?.probabilities;
  if (answer?.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice) ||
      typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
      !probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    throw new Error("Decision provider returned an invalid Choice answer");
  }
  const values = probabilities as Record<string, unknown>;
  if (Object.keys(values).length !== Object.keys(criteria).length ||
      Object.keys(criteria).some(key => typeof values[key] !== "number" || !Number.isFinite(values[key]) || (values[key] as number) < 0 || (values[key] as number) > 1)) {
    throw new Error("Decision provider returned invalid choice probabilities");
  }
  return { choice: answer.choice, confidence: answer.confidence, probabilities: values as Record<string, number> };
}

export function createDecisionClient(resolveTarget: TargetResolver): DecisionModel {
  return {
    async choose({ model, state, instructions, criteria, signal }) {
      const target = await resolveTarget(model);
      if (target.auth !== "bearer") throw new Error("Decision provider requires bearer authentication");
      let response: Response;
      try {
        response = await fetch(endpoint(target.baseUrl, target.providerName), {
          method: "POST",
          headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: target.model, state, questions: { selection: { type: "choice", instructions, criteria } } }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("Decision provider could not be reached");
      }
      if (!response.ok) throw new Error(`Decision provider returned HTTP ${response.status}`);
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new Error("Decision provider returned invalid JSON"); }
      const answers = body && typeof body === "object" ? (body as Record<string, unknown>).answers : null;
      return choiceAnswer(answers && typeof answers === "object" ? (answers as Record<string, unknown>).selection : null, criteria);
    },
  };
}
