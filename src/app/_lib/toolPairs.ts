/**
 * A tool call and what it returned, as one thing.
 *
 * The stream reports them apart — a `delta.toolCalls` when the model asks, a
 * `toolResult` whenever the answer comes back. Drawn straight from those lists
 * the reader gets "🔧 tool call: search" and, somewhere below it, "✅ tool
 * result: search": two rows for one thing, and no way to tell which result
 * belongs to which call once the same tool has run twice. Shared by every
 * surface that draws a run's tool traffic — the chat and the playground had
 * each grown their own rendering of the same wire format.
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
}

interface PairableResult {
  id?: string | undefined;
  name?: string | undefined;
  content: string;
  author?: string | undefined;
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
 * The id is what the engine itself pairs on and it is exact — including for the
 * same tool called twice, which is the case two flat lists cannot express. Name
 * matching is the fallback for a result whose call never reached this turn (a
 * subagent's, whose call belongs to the child's conversation) and for a provider
 * that omits ids.
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
    const byId =
      result.id === undefined
        ? -1
        : calls.findIndex((call, at) => !claimed.has(at) && call.id === result.id);
    const index =
      byId !== -1
        ? byId
        : calls.findIndex(
            (call, at) =>
              !claimed.has(at) &&
              (result.name === undefined || baseName(call.name) === baseName(result.name)),
          );
    if (index === -1) {
      orphans.push(result);
      continue;
    }
    claimed.add(index);
    pairs[index] = {
      ...pairs[index],
      // The result's name wins: it is the display name the engine built, and it
      // carries what the call's name cannot — the MCP server that served it. A
      // call goes out as the bare `get_me`, so a row keyed on it stayed bare for
      // the whole of a run and only named its server once the page reloaded.
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
