import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import { NoopTrace, withTrace } from "@openai/agents";
import type { RunIdentity } from "@/domain/execution/actor";
import { MAX_EVALUATION_TOKEN_CHARS, type EvaluationExpectations, type EvaluationReceipt, type EvaluationReport } from "@/domain/evaluation/types";
import { CONTEXT_ENCRYPTED_PREFIX } from "@/domain/security/secretCipher";
import { evaluationContext } from "@/domain/security/secretContext";
import { applyModelConstraints } from "@/domain/llm/models";
import type { EngineChunk, UsageInfo } from "@/domain/llm/types";
import { ConflictError, UpstreamError, ValidationError } from "@/application/errors";
import { streamAgentRun, type AgentRunInput, type ExecutionDeps } from "@/application/execution/runAgent";
import { executionAuthorization } from "@/application/execution/executionAuthorization";
import { runClock } from "@/application/execution/deps";
import { openModelCall } from "@/application/run/runBracket";
import { runEnding } from "@/application/run/runDeadline";
import { createUsageAggregator } from "@/application/usage/recordUsage";
import { createRunContextBudget } from "@/application/llm/contextBudget";
import { PiiFilter } from "@/application/llm/pii";
import { runtimeFingerprint } from "@/application/runtime/session";
import { modelResponseIsTruncated, modelResponseUsage } from "@/application/runtime/modelUsage";
import { disposeRunDeadline, runDeadlineExceeded, withRunDeadline } from "@/shared/runDeadline";
import { createEvidenceCollector, type RunEvidence } from "./evidence";
import { EVALUATION_INSTRUCTIONS, EVALUATION_REPORT_SCHEMA, parseEvaluationReport } from "./report";

const RECEIPT_LIFETIME_MS = 60 * 60 * 1_000;
interface EvidenceEnvelope {
  version: 1;
  expiresAt: number;
  configuration: string;
  evidence: RunEvidence;
}
export interface AgentEvaluation extends EvaluationReport {
  model: string;
  evaluatedAt: string;
  usage: UsageInfo;
  evidence: RunEvidence;
}
interface EvaluateInput extends RunIdentity {
  agent: Agent;
  configuration: AgentConfiguration;
  token: string;
  expectations: EvaluationExpectations;
  locale: "en" | "ko";
  signal?: AbortSignal;
}

export function createEvaluationUseCases(deps: ExecutionDeps) {
  function seal(input: AgentRunInput, evidence: RunEvidence): EvaluationReceipt {
    const expiresAt = runClock(deps).getTime() + RECEIPT_LIFETIME_MS;
    const envelope: EvidenceEnvelope = { version: 1, expiresAt, configuration: runtimeFingerprint(input.configuration), evidence };
    const token = deps.cipher.encrypt(JSON.stringify(envelope), evaluationContext(input.agent.name, input.user.userId));
    if (token.length > MAX_EVALUATION_TOKEN_CHARS) throw new ValidationError("Evaluation evidence exceeds its size limit");
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }
  function unseal(input: EvaluateInput): RunEvidence {
    let envelope: EvidenceEnvelope;
    try {
      if (!input.token.startsWith(CONTEXT_ENCRYPTED_PREFIX) || input.token.length > MAX_EVALUATION_TOKEN_CHARS) throw new Error();
      envelope = JSON.parse(deps.cipher.decrypt(input.token, evaluationContext(input.agent.name, input.user.userId))) as EvidenceEnvelope;
      if (envelope.version !== 1 || !Number.isFinite(envelope.expiresAt) || !envelope.evidence) throw new Error();
    } catch { throw new ValidationError("Invalid evaluation evidence"); }
    if (envelope.expiresAt <= runClock(deps).getTime()) throw new ConflictError("Evaluation evidence expired; run the Agent again");
    if (envelope.configuration !== runtimeFingerprint(input.configuration)) throw new ConflictError("Agent configuration changed; run the Agent again");
    return envelope.evidence;
  }

  return {
    /** Same execution, credentials, policies and artifacts as the ordinary run. */
    async *run(input: AgentRunInput, warnings: readonly string[] = []): AsyncGenerator<EngineChunk> {
      const collector = createEvidenceCollector(input.configuration, input.messages);
      for (const warning of warnings) collector.observe({ warning });
      let observed = false;
      let attempted = false;
      try {
        for await (const chunk of streamAgentRun({ ...deps, onModelRequest: (...args) => {
          attempted = true;
          collector.onModelRequest(...args);
        } }, input)) {
          observed = true;
          collector.observe(chunk);
          yield chunk;
        }
      } catch (error) {
        // Admission failures retain their HTTP status. Never replay uncertain effects.
        if ((!observed && !attempted) || input.signal?.aborted) throw error;
        const chunk = { error: error instanceof Error ? error.message : "Agent execution failed" };
        collector.observe(chunk);
        yield chunk;
      }
      input.signal?.throwIfAborted();
      yield { evaluation: seal(input, collector.finish()) };
    },

    async evaluate(input: EvaluateInput): Promise<AgentEvaluation> {
      const authorize = executionAuthorization(deps, input.agent.name, input);
      await authorize();
      const evidence = unseal(input);
      const model = input.configuration.model;
      const pii = input.configuration.parameters.piiFiltering ? new PiiFilter() : undefined;
      const data = JSON.stringify({ expectations: input.expectations, evidence });
      const instructions = `${EVALUATION_INSTRUCTIONS}\nWrite human-readable fields in ${input.locale === "ko" ? "Korean" : "English"}.\nJSON schema:\n${JSON.stringify(EVALUATION_REPORT_SCHEMA)}`;
      const prompt = pii?.mask(data) ?? data;
      const params = applyModelConstraints({ model, messages: [], maxTokens: 4_096 });
      const budget = createRunContextBudget(model, undefined, params.maxTokens);
      budget?.chargeText(instructions);
      budget?.chargeText(prompt);
      if (budget && budget.remaining() === 0) throw new ValidationError("Evaluation evidence exceeds this model's context window");
      const bracket = await openModelCall(deps, input.agent, { model }, input);
      const usage = createUsageAggregator(deps.usage, input);
      const signal = withRunDeadline(input.signal);
      let failed = true;
      try {
        signal.throwIfAborted();
        await authorize();
        const response = await withTrace(new NoopTrace(), async () => (await deps.channel.getModel(model)).getResponse({
          systemInstructions: instructions, input: prompt, tools: [], handoffs: [], outputType: "text", tracing: false, signal,
          modelSettings: { maxTokens: params.maxTokens },
        }));
        const cost = modelResponseUsage(model, response);
        await usage.record({ ...cost, agentName: input.agent.name, model });
        if (modelResponseIsTruncated(response, params.maxTokens)) throw new UpstreamError("Evaluation report was truncated");
        const text = response.output.flatMap(item => item.type !== "message" ? [] : typeof item.content === "string" ? [item.content]
          : item.content.flatMap(part => part.type === "output_text" ? [part.text] : [])).join("\n");
        const report = parseEvaluationReport(text, deps.createToolSchemaValidator());
        failed = false;
        return { ...report, model, evaluatedAt: runClock(deps).toISOString(), usage: cost, evidence };
      } catch (error) {
        failed = runDeadlineExceeded(signal) || !input.signal?.aborted;
        throw runEnding(error, signal);
      }
      finally {
        disposeRunDeadline(signal);
        await usage.flush();
        await bracket.close({ failed });
      }
    },
  };
}
