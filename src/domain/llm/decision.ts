/** A closed-set decision. The caller owns the criteria and validates the chosen key. */
export interface ChoiceDecision {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface DecisionModel {
  choose(input: {
    model: string;
    state: string;
    instructions: string;
    criteria: Record<string, string>;
  }): Promise<ChoiceDecision>;
}
