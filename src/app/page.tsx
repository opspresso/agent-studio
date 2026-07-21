import { redirect } from "next/navigation";
import { SignInButton } from "@/components/SignInButton";
import { getSessionUser } from "@/lib/session";

const DOMAINS = [
  {
    label: "projects",
    title: "Projects & versions",
    body: "Author prompts as versioned configs. Publish one version; callers pin it or follow the pointer.",
  },
  {
    label: "agent",
    title: "Agent loop",
    body: "Multi-turn tool execution with turn budgets, skill loading, and transfer to sub-agents.",
  },
  {
    label: "mcp",
    title: "MCP tools",
    body: "Register MCP servers once; their tools join every agent run with encrypted headers.",
  },
  {
    label: "skills",
    title: "Skills",
    body: "Markdown behavior packs, listed to the model and loaded only when it asks.",
  },
  {
    label: "chats",
    title: "Chats",
    body: "Talk to any agent project over streaming SSE, with tool results inline.",
  },
  {
    label: "cost",
    title: "Cost",
    body: "Every call priced from the model registry and rolled up per project, per day.",
  },
] as const;

const TRACE_LINES: Array<{ kind: "meta" | "tool" | "text" | "author"; text: string }> = [
  { kind: "meta", text: 'POST /projects/support-triage/versions/published/agent' },
  { kind: "text", text: 'data: {"delta":{"content":"Looking at the report…"}}' },
  { kind: "tool", text: 'data: {"delta":{"toolCalls":[{"name":"Skill","args":{"name":"triage-rules"}}]}}' },
  { kind: "tool", text: 'data: {"toolResult":{"name":"Skill","content":"# Triage rules…"}}' },
  { kind: "author", text: 'data: {"author":"escalation-agent","delta":{"content":"Severity: P2"}}' },
  { kind: "text", text: 'data: {"delta":{"content":"Filed as P2 with repro steps."}}' },
  { kind: "meta", text: 'data: {"usage":{"inputTokens":812,"outputTokens":164,"costUsd":0.0031}}' },
];

export default async function Home() {
  const user = await getSessionUser();
  if (user) {
    redirect("/projects");
  }

  return (
    <div className="py-10">
      <section className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">
            prompt → publish → call
          </p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
            One studio for prompts, agents, and what they cost.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-neutral-600 dark:text-neutral-300">
            Agent Studio is where a prompt becomes a published version, a version becomes an
            agent with tools, and every call lands in a cost report. Built for teams that run
            LLM workloads in production.
          </p>
          <div className="mt-8 flex items-center gap-4">
            <SignInButton />
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              Sign-in required for every workspace.
            </span>
          </div>
        </div>

        <figure
          aria-label="Example agent run stream"
          className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <figcaption className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
            <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
              agent run · text/event-stream
            </span>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              live
            </span>
          </figcaption>
          <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-6">
            {TRACE_LINES.map((line, i) => (
              <div
                key={i}
                className={
                  line.kind === "tool"
                    ? "text-brand"
                    : line.kind === "author"
                      ? "text-amber-600 dark:text-amber-400"
                      : line.kind === "meta"
                        ? "text-neutral-400 dark:text-neutral-500"
                        : "text-neutral-700 dark:text-neutral-300"
                }
              >
                {line.text}
              </div>
            ))}
            <div className="text-neutral-400 dark:text-neutral-500">
              data: [DONE]
              <span className="trace-cursor ml-1 inline-block h-3 w-1.5 translate-y-0.5 bg-brand" />
            </div>
          </pre>
        </figure>
      </section>

      <section className="mt-16">
        <h2 className="sr-only">What Agent Studio covers</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DOMAINS.map((domain) => (
            <article
              key={domain.label}
              className="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-400 dark:text-neutral-500">
                {domain.label}
              </p>
              <h3 className="mt-2 text-sm font-semibold">{domain.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {domain.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      <p className="mt-12 text-center text-xs text-neutral-400 dark:text-neutral-500">
        Next.js · DynamoDB · one OpenAI-compatible channel for every model
      </p>
    </div>
  );
}
