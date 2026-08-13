/**
 * Every string the console shows a person, in English.
 *
 * This file is the source of truth and `ko.ts` is typed against it, so a key
 * added here without a Korean counterpart fails `pnpm typecheck` rather than
 * rendering an English string inside a Korean page. That is the whole reason
 * the catalogue is TypeScript instead of JSON: the check is the compiler's, and
 * there is no second tool to keep in step.
 *
 * Keys are flat and namespaced `area.thing`. Flat because `keyof typeof en` is
 * then the key type with no path-walking generic behind it, and because
 * grepping a key finds both its definition and its uses.
 *
 * **Error messages are deliberately absent.** `AppError` carries its message as
 * a string through `application` and `domain`, neither of which may import a
 * framework, so translating them means giving every error a code and rewriting
 * 69 throw sites. The console is internal and its errors are read by operators,
 * so they stay in English; this catalogue covers what a page renders on its own.
 *
 * **Product nouns are not translated**, in either catalogue — Project, Skill,
 * Agent, Tool, Plugin, Chat, Model, MCP. Each is an API resource, a URL
 * segment, and what the docs and the Slack bot call it; a console that renamed
 * its copy would make one thing answer to two words. What gets translated is
 * the prose around them: descriptions, actions, states and empty messages.
 */
export const en = {
  // Language toggle. Each language is named in itself — `LOCALE_LABELS` — so
  // only the control around it is translated.
  "locale.label": "Language",
  "locale.change": "Change language",

  // Colour-scheme toggle.
  "theme.label": "Theme",
  "theme.current": "Theme: {name}",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",

  // App chrome: the header, the sidebar and its groups.
  "chrome.tagline": "Agents that work together",
  "chrome.navLabel": "Workspace navigation",
  "chrome.openProjects": "Open projects",
  "chrome.status": "Workspace online · v{version}",
  "nav.group.workspace": "Workspace",
  "nav.group.intelligence": "Intelligence",
  "nav.group.system": "System",
  "nav.overview": "Overview",
  "nav.projects": "Projects",
  "nav.chats": "Chats",
  "nav.artifacts": "Artifacts",
  "nav.profile": "Profile",
  "nav.plugins": "Plugins",
  "nav.skills": "Skills",
  "nav.tools": "Tools",
  "nav.agents": "Agents",
  "nav.members": "Members",
  "nav.audit": "Audit trail",
  "nav.models": "Models",
  "nav.settings": "Settings",

  // Sign in and out.
  "auth.signIn": "Sign in with Google",
  "auth.signOut": "Sign out",
  "login.title": "Sign in to continue",
  "login.product": "AgentDure — an internal LLM platform for prompt, agent, and cost management.",
  "login.domains": "Use your Google account on one of this deployment’s allowed domains.",

  // The signed-out landing page.
  "home.eyebrow": "Version · publish · run",
  "home.headline": "Build an agent once,",
  "home.headlineAccent": " call it from anywhere.",
  "home.lede":
    "Author a prompt or an agent as a project, iterate in versions, publish one — then call it from the console, an OpenAI-compatible API, Slack, a webhook, or another agent. Every run attributed, priced, and bounded.",
  "home.signInHint": "Your Google account, on one of this deployment’s allowed domains.",
  "home.proof.engine": "One engine",
  "home.proof.engineNote": "Every model, every surface",
  "home.proof.traces": "Live traces",
  "home.proof.tracesNote": "Every agent handoff",
  "home.proof.cost": "Exact cost",
  "home.proof.costNote": "Every call attributed",
  "home.streamLabel": "Example agent run stream",
  "home.streamCaption": "agent run · text/event-stream",
  "home.streamLive": "live",
  "home.agentOnline": "● agent online",
  "home.coverage": "What AgentDure covers",
  "home.domain.projects": "Projects & versions",
  "home.domain.projectsBody":
    "Author prompts, agents, and image projects as immutable versions. Publish one; callers pin it or follow the pointer.",
  "home.domain.agent": "Agent loop",
  "home.domain.agentBody":
    "A multi-turn tool loop with turn budgets, on-demand skills, and subagent transfers — streamed end to end.",
  "home.domain.mcp": "MCP tools",
  "home.domain.mcpBody":
    "Register a server once; versions bind it, narrow its tools, and override headers — with per-project OAuth, secrets encrypted at rest.",
  "home.domain.skills": "Skills",
  "home.domain.skillsBody":
    "Markdown behavior packs, listed to the model and loaded only when it asks.",
  "home.domain.plugins": "Agent Plugins",
  "home.domain.pluginsBody":
    "Skills and MCP servers sync from one plugins repo — the source of truth for every name it declares.",
  "home.domain.chats": "Chats",
  "home.domain.chatsBody":
    "Talk to any agent project — replies stream, tool traffic stays inline, and a run outlives the tab that started it.",
  "home.domain.images": "Images",
  "home.domain.imagesBody":
    "Draw or edit from a prompt — as a project type, agent builtins, or an image subagent; an edit can address any image the run has seen.",
  "home.domain.surfaces": "Slack, A2A & webhooks",
  "home.domain.surfacesBody":
    "Per-project Slack bots, A2A in both directions, webhook and schedule triggers — every entry point runs the same engine.",
  "home.domain.cost": "Cost & guards",
  "home.domain.costBody":
    "Every call priced from the model registry and rolled up per project, per caller, per day — daily and monthly thresholds warn, then refuse.",
  // Split from the sentence because the bolded name differs by language: the
  // English page glosses the Korean word, and the Korean page has no gloss to
  // give.
  "home.dureName": "Dure (두레)",
  "home.dure":
    "— a Korean village work cooperative, where neighbors pool their labor to finish what no one could alone. Agents here work the same way.",
  "home.product": "An internal LLM platform for prompt, agent, and cost management.",

  // Vocabulary more than one page uses. A word here is one a reader meets on
  // several screens and should not have to re-learn.
  "common.loading": "Loading…",
  "common.cancel": "Cancel",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.backTo": "← Back to {label}",
  "common.you": "you",
  "common.total": "Total",
  "common.workspaceCatalog": "Workspace catalog",

  // The From/To range over every cost and trace list.
  "dateRange.from": "From",
  "dateRange.to": "To",

  // `useConfirm`. The action button's label is the caller's — it names the
  // action ("Delete", "Publish"), which only the caller knows.
  "confirm.typeToConfirm": "Type “{text}” to confirm",

  // The secret key/value editor, shared by the MCP registry and version bindings.
  "headers.caption": "Headers",
  "headers.empty": "No headers. Add one if the server needs auth.",
  "headers.add": "+ Add header",
  "headers.keyPlaceholder": "Header-Name",
  "headers.valuePlaceholder": "value",
  "headers.removed": "(removed)",
  "headers.remove": "remove",
  "headers.removeHint": "Drop this header from the inherited defaults",
  "headers.secret": "secret",
  "headers.secretHint": "Stored encrypted at rest",
  "headers.deleteRow": "Delete header row",

  // Cost and usage, on all three surfaces that draw it: the overview, a
  // project's usage tab, and a member's profile.
  "usage.calls": "Calls",
  "usage.cached": "Cached",
  "usage.cost": "Cost",
  "usage.none": "No usage in this range.",
  "usage.groupBy.project": "project",
  "usage.groupBy.model": "model",
  "usage.groupBy.provider": "provider",
  "usage.groupBy.department": "department",
  "usage.groupedBy": "Grouped by {axis}",
  "usage.stackedBy": "Stacked by {axis}",

  // The cost dashboard on the overview.
  "cost.title": "Cost",
  "cost.lede":
    "What every project spends, priced per call from the model registry — with daily and monthly limits that warn, then refuse.",
  "cost.departmentsFailed":
    "Project departments could not be loaded, so every project is shown under “(none)”. Reload to attribute this spend.",
  "cost.totalCost": "Total cost",
  "cost.selectedPeriod": "Selected period",
  "cost.totalCalls": "Total calls",
  "cost.modelInvocations": "Model invocations",
  "cost.averageCost": "Average cost",
  "cost.perInvocation": "Per invocation",
  "cost.activeGroups": "Active groups",
  "cost.dailyCost": "Daily cost",

  // Staged attachments, shared by the chat composers and the run panel.
  "attach.images": "Attach images",
  "attach.imagesOrDocuments": "Attach images or documents",
  "attach.remove": "Remove {name}",
  "attach.tooManyImages": "At most {count} images per message",
  "attach.tooManyDocuments": "At most {count} documents per message",
  "attach.unreadable": "{name}: unreadable",

  // The signed-in home.
  "overview.welcome": "Welcome back, {name}",
  "overview.welcomeAnon": "Welcome back",
  "overview.lede":
    "Build a prompt, an agent, or an image project; publish a version and call it from anywhere.",
  "overview.newProject": "New project",
  "overview.newChat": "New chat",
  "overview.recentProjects": "Recent projects",
  "overview.recentProjectsNote": "Recently updated across the workspace — yours first.",
  "overview.allProjects": "All projects",
  "overview.projectsFailed": "Projects could not be loaded.",
  "overview.noProjects": "No projects yet.",
  "overview.recentChats": "Recent chats",
  "overview.recentChatsNote": "Pick a conversation back up where it stopped.",
  "overview.allChats": "All chats",
  "overview.noChats": "No chats yet.",
  "overview.getStarted": "Start with a project",
  "overview.getStartedBody":
    "A project holds a prompt, an agent, or an image workload, saved as versions you can publish. Create one, attach skills and MCP tools to a version, then try it in the Playground — or in a chat, for an agent project.",
  "overview.browseSkills": "Browse skills",
} as const;

export type MessageKey = keyof typeof en;

/** The shape `ko.ts` has to satisfy: every key above, mapped to a string. */
export type Messages = Record<MessageKey, string>;
