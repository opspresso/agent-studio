# Native Agent Runtime

The OpenAI Agents SDK owns agent turns, tool execution, handoffs, nested Agent-as-Tool
runs, Session history and approval decisions. Studio owns preparation, policy, credentials,
budgets, artifacts and persistence around that runtime. Do not add a second agent loop.

- `agent.ts` compiles SDK agents. A handoff changes the active agent in the same Runner;
  an Agent-as-Tool runs a specialist and returns its result to the parent.
- `BoundAgent` preserves SDK identity while isolating invocation resources. Approval state
  is scoped to an SDK agent identity and a call ID; concurrent child invocations require
  distinct call IDs even when providers omit or reuse them.
- Consume native SDK tool-result events. Input validation can produce an SDK error result
  without calling a tool's execution callback. Never lose that traffic or emit it twice.
- PII filtering masks model requests and restores display/tool dispatch. Persist each
  filter's mapping with a pending run, including child-only filters. Reasoning visibility
  controls emission, not provider replay.
- `session.ts` implements a buffered native Session. History and pending RunState commit
  together in encrypted `runtime_sessions` rows using owner-scoped compare-and-swap.
  The ciphertext must use context-bound encryption; do not accept plaintext checkpoints.
- Claim a pending checkpoint before executing an approval. A run interrupted after that
  claim has an uncertain outcome and must never be automatically replayed.
- Rebuild native agent identities before deserializing a saved RunState. Preserve tool
  schemas, binding fingerprints, image handles, call IDs and already-spent resource budgets.
- Chat display records are not model replay. SDK Session items carry the exact model/tool
  traffic; Memory recall remains an independent Context capability.
- Respect output backpressure and cancellation. A consumer leaving must not leave a child
  generator or MCP connection running; chat connection detachment stays outside this layer.
- Capture output bytes through the existing run bracket. File bytes never enter model
  context. Inline image limits and encoding remain owned by domain/llm/imageLimits.ts.
- Tracing must stay local or use an explicitly configured exporter. Never enable the SDK's
  default public OpenAI exporter as a side effect of running an agent.

Focused checks include `runtimeSession.test.ts`, `nativeDelegation.test.ts`,
`agentBindings.test.ts`, `agentModels.test.ts` and the architecture tests. Integration
checks exercise the real Session store only on a dedicated local database ending in `_test`.
