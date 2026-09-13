# LLM preparation and model catalog

Agent execution is owned by the OpenAI Agents SDK integration in
`src/application/runtime/`. Read `../runtime/AGENTS.md` before changing runtime-facing
assembly, PII handling or context budgets.

- `agentAssembly.ts` is the shared source for runtime and prompt-preview capabilities.
  Only reachable, permitted tools may be described; preserve the provider tool-count cap.
- `pii.ts` owns reversible tokens and their streaming boundary handling. Model requests
  are masked when enabled; visible output and trusted tool dispatch use restored values.
  Pending checkpoints retain the exact mapping under authenticated encryption.
- `contextBudget.ts` and `toolResultBudget.ts` own context accounting. Preserve spent
  budgets across approval resumption, and report any truncation explicitly.
- Model facts remain deployment/catalog-owned. Do not copy provider limits or model
  metadata into runtime adapters; consume the existing domain owners.
