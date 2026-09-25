/** The FetchUrl builtin, over the outbound boundary. */

import type * as engine from "@/application/runtime";
import { readUrlContent } from "@/application/llm/urlContent";
import type { AgentConfiguration } from "@/domain/agent/types";
import type { ExecutionDeps } from "./deps";

/**
 * The FetchUrl builtin, or nothing when the Agent did not ask for it.
 *
 * Opt-in rather than always on, and the reason is not cost. Every other outbound
 * request this app makes goes to an address an operator registered; this one
 * goes wherever the model says, and a model is talked into things by the text it
 * reads. Handing that primitive to every agent by default — including ones with
 * no business reading the web — is a decision, so it is made per Agent, the
 * way image generation is.
 */
export function buildUrlFetcher(
  deps: Pick<ExecutionDeps, "http" | "documents">,
  configuration: AgentConfiguration,
): engine.AgentCapabilityDeps["fetchUrl"] {
  if (configuration.parameters.urlFetch !== true) {
    return undefined;
  }
  return (url) => readUrlContent({ http: deps.http, documents: deps.documents }, url);
}
