import { toolCallKey } from "@/domain/llm/types";

/**
 * Pair separately streamed calls and results into stable rows for Chat and
 * Playground, preserving delegation scope and repeated calls to the same tool.
 */

export interface ToolPair {
  /**
   * The tool as it should read. The call's bare name until its result lands,
   * then the result's, which is the one the engine decorated with what it acted
   * on — the skill, the agent, the MCP server.
   */
  name?: string | undefined;
  /** The arguments the model sent. Absent for a result with no call to match. */
  args?: string | undefined;
  /** What came back. Absent while the call is still running. */
  content?: string | undefined;
  /** The subagent that ran it, when it was not the top-level run's own call. */
  author?: string | undefined;
}

interface PairableCall {
  id?: string | undefined;
  name: string;
  args: string;
  author?: string | undefined;
  authorPath?: string[] | undefined;
  transferId?: string | undefined;
}

interface PairableResult {
  id?: string | undefined;
  name?: string | undefined;
  content: string;
  author?: string | undefined;
  authorPath?: string[] | undefined;
  transferId?: string | undefined;
}

/**
 * The tool a name refers to, without what it acted on. A *result* comes back as
 * `Skill: tech-spec` where its call went out as `Skill`, so the fallback has to
 * compare the halves that can agree. It is only ever the fallback — the id below
 * is exact, and two skills in one turn would land here in call order.
 */
function baseName(name: string | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  const colon = name.indexOf(": ");
  return colon === -1 ? name : name.slice(0, colon);
}

/**
 * Pair them up, by call id where there is one and by name and order otherwise.
 *
 * The id is scoped to its delegation and is exact — including for the
 * same tool called twice, which is the case two flat lists cannot express. Name
 * matching stays within the same scope and is only for a provider that omits
 * ids. Results whose calls never reached this turn stay unpaired.
 *
 * Calls keep their original order so a row does not jump as its result lands,
 * and a result nothing claimed is appended rather than dropped.
 */
export function pairToolTraffic(
  calls: readonly PairableCall[],
  results: readonly PairableResult[],
): ToolPair[] {
  const pairs: ToolPair[] = calls.map((call) => ({
    name: call.name,
    args: call.args,
    author: call.author,
  }));
  const claimed = new Set<number>();

  const orphans: PairableResult[] = [];
  for (const result of results) {
    const scope = toolCallKey(result, "");
    const byId =
      result.id === undefined
        ? -1
        : calls.findIndex((call, at) =>
            !claimed.has(at) && call.id === result.id && toolCallKey(call, "") === scope,
          );
    const index =
      byId !== -1
        ? byId
        : calls.findIndex(
            (call, at) =>
              !claimed.has(at) &&
              toolCallKey(call, "") === scope &&
              (call.id === undefined || result.id === undefined) &&
              (result.name === undefined || baseName(call.name) === baseName(result.name)),
          );
    if (index === -1) {
      orphans.push(result);
      continue;
    }
    claimed.add(index);
    pairs[index] = {
      ...pairs[index],
      // Prefer the result's decorated display name, including its MCP server.
      ...(result.name === undefined ? {} : { name: result.name }),
      content: result.content,
      author: result.author ?? pairs[index]?.author,
    };
  }

  for (const orphan of orphans) {
    pairs.push({ name: orphan.name, content: orphan.content, author: orphan.author });
  }
  return pairs;
}
