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
 * well over a hundred throw sites. The console is internal and its errors are
 * read by operators, so they stay in English; this catalogue covers what a page
 * renders on its own.
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
  "chrome.tagline": "Build and operate production AI agents",
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
  "nav.guide": "Guide",
  "nav.plugins": "Plugins",
  "nav.skills": "Skills",
  "nav.tools": "Tools",
  "nav.agents": "Agents",
  "nav.members": "Members",
  "nav.audit": "Audit trail",
  "nav.models": "Models",
  "nav.settings": "Settings",

  // Sign in and out.
  "auth.signIn": "Sign in",
  "auth.signInWith": "Sign in with {provider}",
  "auth.signInWithPassword": "Sign in with password",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.passwordFailed": "Email or password is incorrect.",
  "auth.or": "or",
  "auth.signOut": "Sign out",
  "login.title": "Sign in to continue",
  "login.product": "Agent Studio — build and operate production AI agents.",
  "login.domains": "Use an account on one of this deployment’s allowed domains.",

  // The signed-out landing page.
  "home.eyebrow": "Self-hosted · your network",
  "home.headline": "Production AI agents,",
  "home.headlineAccent": " inside your own network.",
  "home.lede":
    "Installed, not subscribed — one company per install, on your own hardware. Author prompts and agents as versions, publish one, and call it from anywhere: the console, an OpenAI-compatible endpoint, chat bots, other agents. Booting, signing in, and running need nothing outside.",
  "home.signInHint": "Your account, on one of this deployment’s allowed domains.",
  "home.proof.network": "Your network",
  "home.proof.networkNote": "Boot, sign in, run — zero outbound",
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
  "home.coverage": "What Agent Studio covers",
  "home.domain.projects": "Projects & versions",
  "home.domain.projectsBody":
    "Author prompts, agents, and image projects as immutable versions. Publish one; callers pin it or follow the pointer.",
  "home.domain.agent": "Agent loop",
  "home.domain.agentBody":
    "A multi-turn tool loop with turn and context budgets, on-demand skills, subagent transfers, and opt-in URL reading — streamed end to end.",
  "home.domain.mcp": "MCP tools",
  "home.domain.mcpBody":
    "Register a server once; versions bind it, narrow its tools, and override headers — with per-project OAuth, secrets encrypted at rest.",
  "home.domain.skills": "Skills",
  "home.domain.skillsBody":
    "Markdown behavior packs, listed to the model and loaded only when it asks.",
  "home.domain.plugins": "Agent Plugins",
  "home.domain.pluginsBody":
    "Skills and MCP servers sync from one plugins repo — the source of truth for every name it declares.",
  "home.domain.catalog": "Capability catalog",
  "home.domain.catalogBody":
    "One searchable index of skills, MCP tools, and external agents. A version that opts in has its bindings widened per run by what the prompt and the request ask for.",
  "home.domain.chats": "Chats",
  "home.domain.chatsBody":
    "Talk to any agent project — attach images and documents, replies stream, tool traffic stays inline, and a run outlives the tab that started it.",
  "home.domain.images": "Images",
  "home.domain.imagesBody":
    "Draw or edit from a prompt — as a project type, agent builtins, or an image subagent; an edit can address any image the run has seen.",
  "home.domain.artifacts": "Artifacts",
  "home.domain.artifactsBody":
    "Every image or file a run produced, stored under a signed address and listed per project and per person — whichever surface it came from.",
  "home.domain.surfaces": "Slack, A2A & webhooks",
  "home.domain.surfacesBody":
    "Per-project Slack bots that answer mentions, DMs, and keyword-matched channel messages, A2A in both directions, webhook and schedule triggers — every entry point runs the same engine.",
  "home.domain.cost": "Cost & guards",
  "home.domain.costBody":
    "Every call priced — what the channel charged, or the model registry's rate — and rolled up per project, per caller, per day. Daily and monthly thresholds warn, then refuse; concurrency and member tiers bound the rest.",
  "home.domain.traces": "Traces & audit",
  "home.domain.tracesBody":
    "Every agent run traced turn by turn, tool traffic included, and reachable from its project. Secret reveals, admin overrides, and deletions each leave an audit row.",
  "home.install.title": "Installed, not subscribed",
  "home.install.body":
    "Agent Studio ships as a container — one host with Docker Compose, or Kubernetes with the Helm chart. What it asks of you is small, and what it reaches outside is yours to decide.",
  "home.install.floor": "PostgreSQL is the floor",
  "home.install.floorNote":
    "One database with pgvector, and an OpenAI-compatible endpoint for the models — your own vLLM, LM Studio, or router counts. The app migrates its schema at boot.",
  "home.install.offline": "Air-gapped works",
  "home.install.offlineNote":
    "The model catalog, the plugin registry, and the container images each have an offline path: upload the snapshot instead of fetching it.",
  "home.install.optional": "Every connection is a choice",
  "home.install.optionalNote":
    "Slack, Telegram, Teams, outbound A2A, hosted model APIs — each is a switch, and leaving one off disables only itself.",
  "home.product": "Build and operate production AI agents.",

  // Vocabulary more than one page uses. A word here is one a reader meets on
  // several screens and should not have to re-learn.
  "common.loading": "Loading…",
  "common.cancel": "Cancel",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.backTo": "← Back to {label}",
  "common.you": "you",
  "common.durationSeconds": "{seconds}s",
  "common.durationMinutes": "{minutes}m {seconds}s",
  "common.reasoning": "Reasoning",
  "common.reasoningTokens": "{count} tok",
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

  // Page-level failures: the segment error boundaries and the missing page.
  "error.pageTitle": "This page could not be shown",
  "error.pageBody": "Something failed while rendering. Try again — if it keeps failing, the digest below identifies it in the server log.",
  "error.retry": "Try again",
  "error.notFoundTitle": "Page not found",
  "error.notFoundBody": "The address does not match any page in this console.",
  "error.backHome": "Back to overview",

  // Staged attachments, shared by the chat composers and the run panel.
  "attach.drop": "Drop to attach",
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

  // The guide page: what this console is for, and the shortest path through it.
  // Longer prose than anywhere else here, and deliberately so — it is the one
  // page whose content *is* the text.
  "guide.title": "Guide",
  "guide.lede":
    "How Agent Studio works, and the shortest path from an empty project to an agent other people can call. Every page it names is in the sidebar.",

  "guide.start.title": "Start here",
  "guide.start.body":
    "Four steps, each on a tab of your own project. Nothing you save is reachable from outside until you publish it.",
  "guide.start.step1": "Create a project",
  "guide.start.step1Body":
    "Projects → New project. The name is the identifier every caller uses and cannot be changed afterwards; the type — llm, agent, or image — is chosen here too.",
  "guide.start.step2": "Write a version in the Playground",
  "guide.start.step2Body":
    "A version holds the model, the prompts, the budgets, and everything the run may reach. Save it and run it in the panel beside the editor. A saved version is a snapshot, not a deployment, so change it as often as you like.",
  "guide.start.step3": "Publish one",
  "guide.start.step3Body":
    "Publishing moves a pointer. A caller that asks for the published version follows it from then on; a caller that pinned a version number stays exactly where it was.",
  "guide.start.step4": "Let something call it",
  "guide.start.step4Body":
    "The API Reference tab documents this project's own endpoints with a copyable curl for each. The Integrations tab issues the project token and connects Slack, Telegram, Teams, A2A, and AG-UI.",

  "guide.words.title": "The words this console uses",
  "guide.words.project": "Project",
  "guide.words.projectBody":
    "One named unit of work, with one type. It owns its versions, its cost limits, its integrations, and who may see it.",
  "guide.words.version": "Version",
  "guide.words.versionBody":
    "An immutable snapshot of a project: model, prompts, tools, budgets. Publishing marks one of them as the answer to a request that does not name a number.",
  "guide.words.run": "Run",
  "guide.words.runBody":
    "One execution of a version. Every run is priced, attributed to whoever caused it, bounded by a deadline, and recorded as a trace.",
  "guide.words.caller": "Caller",
  "guide.words.callerBody":
    "Who caused a run — you in the console, a project token, a person in Slack. Spend and concurrent runs are counted against the caller, not the project alone.",
  "guide.words.tier": "Tier",
  "guide.words.tierBody":
    "Your rung: guest, member, or admin. It decides whether you may create projects and issue tokens, how many runs you may have in flight, and what you may spend in a month. Your own numbers are on the Profile page.",

  "guide.types.title": "Three kinds of project",
  "guide.types.llm": "llm — a single-shot prompt",
  "guide.types.llmBody":
    "A user prompt template with {{variables}} filled in at run time, answered once. No tools, no turns after the first.",
  "guide.types.agent": "agent — a multi-turn tool loop",
  "guide.types.agentBody":
    "The model works until it has an answer: loading skills, calling MCP tools, handing work to a subagent, drawing images, reading a URL. Which of those it may do is the version's decision, not the model's.",
  "guide.types.image": "image — draw or edit",
  "guide.types.imageBody":
    "A picture from a prompt, or an edit of one you attach. There is no chat completion to hand back, so the endpoints that answer with one refuse this type; the console, chats, and A2A return the image itself.",

  "guide.reach.title": "What a version may reach",
  "guide.reach.body":
    "All of it is off until a version turns it on, and a run that could not use something says so in its answer rather than staying quiet about it.",
  "guide.reach.skills": "Skills",
  "guide.reach.skillsBody":
    "Behaviour written as Markdown. The prompt carries only the name and description of each; the model loads a body when it decides it needs one. The Skills page lists what this deployment has.",
  "guide.reach.tools": "MCP tools",
  "guide.reach.toolsBody":
    "Servers registered on the Tools page. A version binds one, narrows which of its tools are offered, and can override the headers sent outbound — secrets included, stored encrypted.",
  "guide.reach.subagents": "Subagents",
  "guide.reach.subagentsBody":
    "Another project, or an entry on the Agents page, that a run can hand a task to. The answer streams back marked with the subagent that wrote it, and its cost is attributed to the same caller.",
  "guide.reach.catalog": "Capability catalog",
  "guide.reach.catalogBody":
    "One searchable index of every skill, tool, and agent. Turn on “Find capabilities for each request” and each run searches it for what the request is actually about — which widens the version's bindings for that run and never replaces them.",
  "guide.reach.builtins": "Built-ins",
  "guide.reach.builtinsBody":
    "Switches on the version: draw and edit images, read a URL the model chose, save a file the reader can download, read Slack history where a bot is connected.",
  "guide.reach.memory": "Memory",
  "guide.reach.memoryBody":
    "What earlier runs stored, recalled before the first token — when the version binds a memory server that offers a recall tool. Without one the switch is inert, and every run says so rather than starting quietly without a memory.",

  "guide.surfaces.title": "Where it can answer",
  "guide.surfaces.body":
    "Every entry point below runs the same engine on the same published version, and every run lands in the same cost and trace records.",
  "guide.surfaces.console": "The console",
  "guide.surfaces.consoleBody":
    "The Playground for a version you are still writing, and Chats for a conversation with a published agent — attachments, streamed replies, tool traffic in line. A chat run outlives the tab that started it.",
  "guide.surfaces.http": "HTTP",
  "guide.surfaces.httpBody":
    "Three shapes on the API Reference tab: this app's own predict endpoint, an OpenAI-compatible chat completions endpoint, and the agent endpoint that streams tool traffic. A project token authenticates them.",
  "guide.surfaces.chatbots": "Slack, Telegram, Teams",
  "guide.surfaces.chatbotsBody":
    "A bot per project, connected on the Integrations tab. Each answers mentions and direct messages, keeps a thread's history, and replies by editing one message as the answer grows.",
  "guide.surfaces.triggers": "Webhooks and schedules",
  "guide.surfaces.triggersBody":
    "On the Settings tab: one webhook URL for something outside to fire, and any number of cron schedules. Both run the published version and keep their history beside them.",
  "guide.surfaces.a2a": "A2A",
  "guide.surfaces.a2aBody":
    "Publish this project as an A2A agent for another system to call, and register other agents to hand work to. Both directions are on the Integrations tab.",
  "guide.surfaces.agui": "AG-UI",
  "guide.surfaces.aguiBody":
    "Embed a published project in your own app: the client sends its thread and gets the protocol's events back, so the agent runs inside a product rather than beside it.",

  "guide.limits.title": "Cost, limits, and what is kept",
  "guide.limits.cost": "Every run is priced",
  "guide.limits.costBody":
    "What the channel charged, or the registry's rate for that model. The overview rolls it up per project and per model, a project's Usage tab per caller, and your Profile page shows your own.",
  "guide.limits.guards": "Thresholds alert, then refuse",
  "guide.limits.guardsBody":
    "A project's daily and monthly limits live on its Settings tab. Crossing the alert threshold posts one notification to the channels the project named and runs carry on; crossing the block threshold refuses them until the window rolls over — UTC midnight for the day, the first for the month.",
  "guide.limits.tier": "Your tier bounds you too",
  "guide.limits.tierBody":
    "A monthly cap across every project, and a ceiling on how many runs you may have in flight at once. The Profile page shows both, and an admin can move them.",
  "guide.limits.records": "What a run leaves behind",
  "guide.limits.recordsBody":
    "A trace per run with its turns and tool calls on the project's Traces tab, and every image or file it produced under Artifacts — yours on the sidebar's Artifacts page, the project's on its own tab.",

  "guide.trouble.title": "When something does not work",
  "guide.trouble.refused": "A run was refused over cost",
  "guide.trouble.refusedBody":
    "Either the project's daily or monthly threshold, or your tier's monthly cap. The project's Settings tab shows the first, your Profile the second; an admin can raise either.",
  "guide.trouble.model": "The model I want is not in the list",
  "guide.trouble.modelBody":
    "The Models page lists what this deployment can reach, and only an admin turns one on. A model the catalog does not carry still runs, but its usage is recorded at zero cost.",
  "guide.trouble.tool": "The model never calls my MCP tool",
  "guide.trouble.toolBody":
    "Check the version's binding — one narrowed to a list of tools hides the rest — and that the server answered discovery, which the Tools page shows. A run that could not reach a bound server says so in its answer.",
  "guide.trouble.slack": "The Slack bot stays silent",
  "guide.trouble.slackBody":
    "It answers mentions, direct messages, and channel messages matching the keywords you gave it; anything else it ignores on purpose. The Integrations tab has a test button that checks the bot token, and lists the channels the bot has been invited to.",
  "guide.trouble.tab": "I closed the tab mid-answer",
  "guide.trouble.tabBody":
    "The run keeps going — the browser leaving means the reader left, not stop. Reopen the chat and the answer is there.",

  "guide.more.title": "Where to read more",
  "guide.more.body":
    "Each project's API Reference tab documents that project. The install, configuration, security, and operations documents ship with the source under docs/ — INSTALL.md, CONFIGURATION.md, SECURITY.md, OPERATIONS.md — so they are readable on a deployment with no internet at all.",

  // Chats: the sidebar, the thread, the composer and the parts a turn is drawn
  // from.
  "chat.more": "Show older chats",
  "chat.answerReady": "Answer complete",
  "chat.new": "New chat",
  "chat.list": "Chats",
  "chat.none": "No chats yet.",
  "chat.delete": "Delete chat",
  "chat.notFound": "Chat not found.",
  "chat.reloadFailed": "This reply is saved, but the conversation could not be reloaded.",
  "chat.jumpToLatest": "Jump to the latest message",
  "chat.send": "Send",
  "chat.stop": "Stop",
  "chat.placeholder": "Send a message…",
  "chat.firstPlaceholder": "Send your first message…",
  "chat.pickProject": "Pick an agent project and send your first message.",
  "chat.project": "Project",
  "chat.noAgentProjects": "No agent projects yet",
  "chat.noAgentProjectsBody":
    "Chats run against an agent project. Create one from Projects to start chatting.",
  "chat.running": "Running",
  "chat.answeredIn": "Answered in {duration}",
  "chat.via": "via {path}",
  "chat.imageGone": "This image is no longer available.",
  "chat.fileWhenDone": "available when this reply finishes",
  "chat.attachedImage": "Attached image",
  "chat.generatedImage": "Generated image",
  "chat.documentRead": "Read {note}",

  // The projects catalog and its create form.
  //
  // The fallbacks below ("Failed to load projects") are this page's own words
  // for a fetch that never reached a server. A message the server *did* send
  // arrives on the `Error` and is shown as written — English, per the rule at
  // the top of this file.
  "projects.lede":
    "Prompt, agent, and image projects — iterate in versions, publish one for callers.",
  "projects.new": "New project",
  "projects.empty": "No projects yet. Create your first one.",
  "projects.loadFailed": "Failed to load projects",
  "projects.createFailed": "Failed to create project",
  "projects.published": "published: v{version}",
  "projects.create": "Create",
  "projects.name": "Name",
  "projects.namePlaceholder": "my-project",
  "projects.nameHint": "Lowercase letters, digits, and hyphens only. Immutable identifier.",
  "projects.displayName": "Display name",
  "projects.displayNamePlaceholder": "My Project",
  "projects.description": "Description",
  "projects.departmentCode": "Department code",
  "projects.departmentHint": "Optional code used to group project ownership and costs.",
  "projects.type": "Type",
  "projects.type.llm": "llm — single-shot prompt",
  "projects.type.agent": "agent — multi-turn tool loop",
  "projects.type.image": "image — generate or edit images",
  "projects.privateBadge": "Private",
  "projects.cloneFailed": "Failed to clone project",

  // One project's header and tab strip.
  "project.badge": "AI project",
  "project.lede": "Design, test, and observe this project from one workspace.",
  "project.ownedBy": "Owned by ",
  "project.clone": "Clone",
  "project.cloneTitle": "Clone {name}",
  "project.tab.playground": "Playground",
  "project.tab.versions": "Versions",
  "project.tab.compare": "Compare",
  "project.tab.usage": "Usage",
  "project.tab.artifacts": "Artifacts",
  "project.tab.traces": "Traces",
  "trace.inConversation": "conversation",
  "project.tab.apiReference": "API Reference",
  "project.tab.integrations": "Integrations",
  "project.tab.settings": "Settings",

  // The playground: version picker, save, and the publish ask.
  "playground.loadFailed": "Failed to load project",
  "playground.saveFailed": "Failed to save version",
  "playground.publishFailed": "Failed to publish version",
  "playground.notFound": "Project not found",
  "playground.newVersion": "+ New version",
  "playground.version": "v{version}",
  "playground.versionPublished": "v{version} (published)",
  "playground.unsaved": "unsaved",
  "playground.saved": "Saved v{version}",
  "playground.createVersion": "Create version",
  "playground.save": "Save",
  "playground.readOnly": "Read-only — the owner or an admin can edit",
  "playground.publishTitle": "Publish this project?",
  "playground.publishBody":
    "“{project}” is not published yet. Publish v{version} to open it to callers — the API, A2A, triggers, Slack, and other projects’ subagents.",
  "playground.publishConfirm": "Publish v{version}",
  "playground.preview": "Preview",
  "playground.run": "Run",

  // What a version binds: MCP servers, their tools, header overrides, subagents.
  "bindings.mcpServers": "MCP servers",
  "bindings.searchServers": "Search registered MCP servers",
  "bindings.subagents": "Subagents",
  "bindings.searchSubagents": "Search projects and external agents",
  "bindings.serverUnreachable": "Could not reach this server",
  "bindings.serverUnreachableSuffix":
    " — a run would offer none of this server’s tools until it answers.",
  "bindings.loadingTools": "Loading tools…",
  "bindings.noTools": "This server exposes no tools.",
  "bindings.allToolsOffered": "Every tool is offered. Select some to narrow what the model sees.",
  "bindings.someToolsOffered": "{chosen} of {total} tools offered.",
  "bindings.toolGone": "no longer exposed",
  "bindings.addHeaderOverride": "+ Add header override",
  "bindings.noOverridesNoDefaults":
    "No overrides, and this server’s registry entry defines no headers either.",
  "bindings.noOverrides": "No overrides — this version uses the headers above unchanged.",

  // The version editor's form. The example JSON schema in the "Structured
  // output" dialog is not here: it is a snippet to copy, not prose to read.
  "version.invalidJson": "Invalid JSON",
  "version.model": "Model",
  "version.selectModel": "Select a model…",
  "version.modelUnlisted": "Model is not in the catalog; usage will be recorded with $0 cost.",
  "version.fallbackModel": "Fallback model (optional)",
  "version.none": "None",
  "version.default": "Default",
  "version.systemPrompt": "System prompt",
  "version.systemPromptImagePlaceholder":
    "Watercolor style, soft pastel tones, no text in the image.",
  "version.systemPromptPlaceholder": "You are a helpful assistant.",
  "version.systemPromptImageHint":
    "Prepended to every image prompt as the version’s persistent style.",
  "version.userPromptTemplate": "User prompt template",
  "version.userPromptPlaceholder": "Summarize: {{input}}",
  // The double braces are the template's own syntax, not a placeholder for the
  // translator: `interpolate` leaves them alone because `t` is called with no
  // values here.
  "version.userPromptHint": "Use {{variable}} placeholders rendered server-side at run time.",
  "version.userPromptAgentHint":
    "Agent runs ignore this template — the conversation supplies the user turn. Clear it to remove this field.",
  "version.temperature": "Temperature",
  "version.maxTokens": "Max tokens",
  "version.defaultPlaceholder": "default",
  "version.reasoningTrace": "Record the reasoning",
  "version.reasoningTraceHint":
    "Keep what the model thought before answering, so it can be read back in the chat and the playground. Off by default: reasoning restates the request in the model's own words, and it also reaches anyone holding this project's API token. It is shown, never sent back as history.",
  "version.reasoningEffort": "Reasoning effort",
  "version.maxTurns": "Max turns",
  "version.piiFiltering": "PII filtering",
  "version.piiImageHint":
    "Does not apply to an image run — the prompt reaches the provider unmasked. Uncheck to remove this option.",
  "version.piiHint":
    "Masks emails, phone numbers, Korean registration numbers and card numbers with reversible tokens before dispatch. What an MCP tool receives is not masked.",
  "version.callerContext": "Tell the run who is asking (name, timezone)",
  "version.callerImageHint":
    "Does not apply to an image run — its prompt has no caller block. Uncheck to remove this option.",
  "version.callerHint":
    "Anywhere a person runs it — chat, Playground, a signed-in API call, Slack. An API token, a trigger and inbound A2A carry no caller. PII filtering does not mask a name.",
  "version.structuredOutput": "Structured output (JSON schema)",
  "version.aboutStructuredOutput": "About structured output",
  "version.structuredOutputTitle": "Structured output",

  // The structured-output help dialog. Split into fragments around the inline
  // `<Code>` tokens rather than kept as whole sentences: the tokens are the
  // literal field names a reader types, so they must stay set in monospace —
  // and Korean puts them at different points in the clause, which a fixed
  // prefix and suffix could not follow. The sample JSON below the prose is not
  // translated; it is a snippet to copy.
  "structured.intro1":
    "With the checkbox on and a schema filled in, the model’s reply is a single JSON document matching the schema — sent as ",
  "structured.intro2":
    ". There is no prose around it: give the schema a field for any sentence the model should write, and have your caller parse the reply as JSON.",
  "structured.root1": "The root must be an ",
  "structured.root2": ". Mark every property ",
  "structured.root3": " and set ",
  "structured.root4": " — the strictest providers accept exactly that shape.",
  "structured.description1": "Each property’s ",
  "structured.description2":
    " is the instruction the model reads for that field; longer guidance belongs in the system prompt.",
  "structured.empty1": "The checkbox alone does nothing — with an empty schema no ",
  "structured.empty2": " is sent and the reply stays plain text.",
  "structured.sampleSchema": "Sample schema",
  "structured.whatReturns": "What the model returns",
  "version.imageTools": "Images (GenerateImage + EditImage tools)",
  "version.imageToolsHint":
    "Lets the agent draw a picture and change an existing one — an image the user attached, or one it drew earlier.",
  "version.imageModel": "Image model",
  "version.fetchUrl": "Read URLs (FetchUrl tool)",
  "version.fetchUrlHint":
    "Lets the agent read a web address it names — a page, a PDF, a data file or an image. Off by default: every other outbound request goes somewhere an operator registered, while this one goes wherever the model decides.",
  "version.slackWorkspace": "Read Slack (SlackHistory, SlackThread, SlackUser, SlackChannels)",
  "version.slackWorkspaceHint":
    "Lets the agent read the Slack workspace this project's bot is installed in: channel history, threads, and who a user id is. Read-only — it can never post. Off by default, and inert unless the project has an enabled Slack bot. Note that projects are a shared catalog, so anyone who can run this project can read anything the bot can.",
  "version.bindingsInertImage":
    "An “image” project draws from a prompt and offers no tools — the bindings below are stored but never used. Remove them here; new ones cannot be added.",
  "version.bindingsInertLlm":
    "An “llm” project runs a single completion, which offers no tools — the bindings below are stored but never used. Remove them here; new ones cannot be added.",
  "version.skills": "Skills",
  "version.searchSkills": "Search registered skills",
  "version.dynamicCapabilities": "Find capabilities for each request",
  "version.dynamicCapabilitiesHint":
    "Searches the registry with this version’s system prompt and the incoming request, and offers what it finds on top of the bindings above. The bindings are always offered in full. An MCP server that needs its own sign-in is offered only once this project has connected it — a connection is made from that server’s own settings and shared by every version, so it counts here even where this version never bound the server.",

  "version.memoryRecall": "Recall memory before each run",
  "version.memoryRecallHint":
    "Before the first token, the run asks every bound MCP server that offers a “recall” tool (mcp-memory) about the incoming request and adds what it remembers to the system prompt — so the model starts from what this project already knows instead of having to think of asking. The recall tools stay available as before. Costs one call per run; inert, with a warning, when no bound server offers one.",
  "version.memoryRecallUnbound":
    "Recall is on, but none of this version’s MCP bindings can offer a “recall” tool — none is bound, or every binding’s tool selection leaves it out. Bind a memory server (mcp-memory) or turn recall off; until then every run starts without a memory and says so.",

  // The three tabs of one binding's settings dialog.
  "mcpSettings.tools": "Tools",
  "mcpSettings.toolsNote":
    "Which of this server’s tools this version offers the model. Saved with the version.",
  "mcpSettings.overrides": "Header overrides",
  "mcpSettings.overridesNote":
    "Layered over the registry entry’s headers, for this version only. Saved with the version.",
  "mcpSettings.connection": "Connection",
  "mcpSettings.connectionNote":
    "This project’s own credentials for the server, shared by all its versions. Saved immediately, not with the version.",
  "mcpSettings.title": "{server} settings",
  "mcpSettings.savesWholeVersion": "Saves the whole version, not just this server.",
  "mcpSettings.close": "Close",

  // The playground's Run panel.
  "run.failed": "Run failed",
  "run.variables": "Variables",
  "run.noVariables": "No template variables detected.",
  "run.messageLabel": "Message",
  "run.editLabel": "Edit instruction",
  "run.imagePromptLabel": "Image prompt",
  "run.askPlaceholder": "Ask the agent…",
  "run.editPlaceholder": "Describe the edited result…",
  "run.generatePlaceholder": "Describe the image to generate…",
  "run.images": "Images",
  "run.sourceImages": "Source images",
  "run.attachHintEdits": "The prompt edits these images.",
  "run.attachHintGenerate": "Attach an image to edit it instead of generating a new one.",
  "run.attachHintLook": "Attached images are sent with the run for the model to look at.",
  "run.cannotEdit": "This model cannot edit images; the run will be rejected.",
  "run.noImageInput": "This model does not accept image input; the run will be rejected.",
  "run.size": "Size",
  "run.quality": "Quality",
  "run.generating": "Generating image… this can take a minute.",
  "run.imageWillAppear": "Generated image will appear here.",
  "run.outputWillStream": "Output will stream here.",
  "run.running": "running:",
  "run.ran": "ran:",
  "run.agentsInvolved": "agents involved: {agents}",

  // The playground's Preview pane.
  "preview.failed": "Failed to build the preview",
  "preview.refresh": "Refresh",
  "preview.build": "Build preview",
  "preview.request": "Request",
  "preview.requestHint":
    "Searched against the registry alongside the system prompt. Leave it empty to see what every run starts with.",
  "preview.requestPlaceholder": "e.g. what is the latest EKS version?",
  "preview.hideTools": "Hide tools",
  "preview.chars": "{count} chars",
  "preview.tools": "· {count} tools",
  "preview.stale": "· stale",
  "preview.discovered": "Found for this request, on top of the bindings: {names}",
  "preview.noPrompt":
    "This version sends no prompt of its own; the conversation supplies everything.",
  "preview.toolsOffered": "Tools offered ({count})",
  "preview.blurb":
    "Builds the system prompt the way a run does — skill table, connected MCP servers and their tool names, transfer instructions — by contacting the bound MCP servers.",

  // A project's own credentials for one MCP server.
  "mcpConn.connected": "Connected",
  "mcpConn.needsAuth": "Not authorized",
  "mcpConn.needsReauth": "Reconnect required",
  "mcpConn.readFailed": "Could not read this server’s registry entry.",
  "mcpConn.clientId": "Client ID",
  "mcpConn.clientSecret": "Client secret",
  "mcpConn.connect": "Connect",
  "mcpConn.reauthorize": "Reauthorize",
  "mcpConn.noAuthNeeded":
    "This server does not require authorization. Whatever credentials it needs come from the registry entry’s own headers, plus any override above.",
  "mcpConn.noClientDocument":
    "This provider accepts neither client ID metadata documents nor dynamic registration. Register an app with it, then save its client ID and secret here.",
  "mcpConn.authorizedBy": "Authorized by {who} on {when}",
  "mcpConn.saveCredentials": "Save credentials",
  "mcpConn.disconnect": "Disconnect",

  // Wording the four registry catalogs (skills, tools, agents, plugins) share.
  // Each page had its own copy of these; a reader meets them on all four.
  "registry.nameLabel": "Name",
  "registry.nameHint": "Lowercase letters, digits, and hyphens only.",
  "registry.description": "Description",
  "registry.modelSummary": "One-line summary shown to the model",
  "registry.content": "Content (markdown)",
  "registry.contentHeading": "Content",
  "registry.operatorNotes":
    "Operator notes for the console. Not sent to the model — only the description is.",
  "registry.register": "Register",
  "registry.create": "Create",
  "registry.url": "URL",
  "registry.headersEmpty": "No headers. Add one if the endpoint needs auth.",

  // Skills.
  "skills.lede":
    "Markdown behavior instructions loaded on demand by the agent engine. Synced skills arrive through Plugins.",
  "skills.new": "New skill",
  "skills.filter": "Filter skills…",
  "skills.empty": "No skills yet. Sync a plugins repo, or create one here.",
  "skills.namePlaceholder": "my-skill",
  "skills.contentPlaceholder": "# Instructions…",
  "skills.noContent": "No content.",

  // External agents.
  "agents.lede":
    "External OpenAI-compatible and A2A endpoints a project version can bind as remote subagents.",
  "agents.register": "Register agent",
  "agents.registerTitle": "Register external agent",
  "agents.filter": "Filter agents…",
  "agents.empty":
    "No external agents yet. Register an OpenAI-compatible or A2A endpoint to use it as a remote subagent.",
  "agents.namePlaceholder": "my-agent",
  "agents.protocol": "Protocol",
  "agents.cardUrl": "Agent Card URL",
  "agents.sendPlaceholder": "Send one message to the agent…",

  // MCP servers.
  "tools.lede":
    "MCP servers that expose tools to agents over streamable HTTP — registered once, bound per version.",
  "tools.register": "Register MCP",
  "tools.runManaged": "Run managed",
  "tools.registerTitle": "Register MCP server",
  "tools.filter": "Filter servers…",
  "tools.empty": "No MCP servers yet. Sync a plugins repo, or register one here.",
  "tools.namePlaceholder": "my-mcp",
  "tools.contentPlaceholder": "Setup steps, caveats, links…",
  "tools.descriptionPlaceholder": "Fetches an image URL and returns its bytes",

  // Agent Plugins.
  "plugins.lede":
    "Agent Plugins packages synced from GitHub — each bundles skills and MCP servers, and the repo owns every name it declares.",
  "plugins.filter": "Filter plugins…",
  "plugins.empty": "No plugins yet. Add the repository and token in Settings, then sync.",
  "plugins.noSkills": "This plugin declares no skills.",
  "plugins.noServers": "This plugin declares no MCP servers.",
  "plugins.uploadArchive": "Upload archive",
  "plugins.uploadArchiveHint":
    "A .tar.gz of the plugins repository (git archive or tar of a checkout) — for a deployment that cannot reach GitHub.",
  "plugins.archiveSource": "Archive: {name}",
  "plugins.uploadFailed": "Upload failed",

  // Artifacts.
  "artifacts.lede":
    "Images and documents your runs produced. A run started by Slack, a trigger or an A2A call belongs to its project — those are on the project’s own tab.",
  "artifacts.empty": "Nothing kept yet. Images and documents your runs produce show up here.",
  "artifacts.filter": "Filter…",
  "artifacts.delete": "Delete",
  "artifacts.all": "All",
  "artifacts.images": "Images",
  "artifacts.preview": "Preview",
  "artifacts.documents": "Documents",
  "artifacts.attached": "Attached",
  "artifacts.view": "View",
  "artifacts.download": "Download",
  "artifacts.loadMore": "Load more",
  "artifacts.unavailable": "No longer available",
  "artifacts.imageAlt": "Generated image",
  "artifacts.documentAlt": "{type} document",
  // Who drew it. The model id beside this is never translated — it is an
  // identifier a provider owns, like the product nouns.
  "artifacts.producedBy": "by {name}",
  "artifacts.deleteTitle": "Delete artifact",
  // Said before the fact because it cannot be said after — see the caller.
  "artifacts.deleteBody":
    "This removes the {kind} from storage. Anywhere it was shown — a chat message, a Slack thread — will show it as unavailable. This cannot be undone.",
  // The kind as it reads inside that sentence, which the filter labels above
  // cannot supply: those are plural headings for a segmented control.
  "artifacts.kindImage": "image",
  "artifacts.kindDocument": "document",

  // Managed MCP: a container this host runs. The start dialog and the server's
  // own settings edit the same fields, so the wording is shared.
  "managed.title": "Run a managed MCP server",
  "managed.start": "Start",
  "managed.hint": "Starts a container on this host, reachable only from it.",
  "managed.namePlaceholder": "image-fetch",
  "managed.nameHint": "Also the container’s name, so the two stay findable together.",
  "managed.image": "Image",
  "managed.imagePlaceholder": "…dkr.ecr.ap-northeast-2.amazonaws.com/mcp-image-fetch:v1.0.1",
  "managed.imageHint": "Any registry the host can pull from — its own ECR needs no credentials.",
  "managed.port": "Container port",
  "managed.envRefs": "Environment references",
  "managed.envRefsPlaceholder": "/env/prod/mcp-image-fetch",
  "managed.envRefsHint":
    "Paths of env files on the host, not values — the secrets never pass through here.",
  "managed.envVars": "Environment variables",
  "managed.envVarsEmpty": "No direct environment variables.",
  "managed.addVariable": "+ Add variable",
  "managed.args": "Arguments",
  "managed.argsHint":
    "One container entrypoint argument per line. {{PORT}} becomes the effective listen port; arguments are not run through a shell.",
  "managed.path": "Endpoint path",
  "managed.pathPlaceholder": "/mcp",
  "managed.urlSetByRuntime": "Set by the managed runtime.",

  // The project's Integrations tab: how other systems reach it.
  "pint.lede":
    "How other systems reach this project — the token an API caller presents, the chat platforms whose bots run it, and its A2A and AG-UI exposure. What the project itself is, its cost limits and its triggers stay under Settings.",
  "pint.ownerOnly": "Only the project owner ({owner}) or an admin can change these integrations.",
  "pint.aguiLede":
    "The published version answers AG-UI runs at this address — an application sends a RunAgentInput and reads an event stream. The thread id it sends is the run’s conversation, and any tools it declares are offered to the run and executed on its side. Call it from a server of your own — the token is a server credential — presenting it in",
  "pint.aguiPublish": "Publish a version to expose this project over AG-UI.",
  "pint.aguiCopy": "Copy example",

  // A project's settings tab: the sections and their forms.
  "pset.dangerZone": "Danger zone",
  "pset.visibility": "Visibility",
  "pset.visibilityPublic": "Public",
  "pset.visibilityPublicHint": "Every signed-in member can view, run and clone this project.",
  "pset.visibilityPrivate": "Private",
  "pset.visibilityPrivateHint": "Only you and the invited members below can view, run and clone it.",
  "pset.invitedMembers": "Invited members",
  "pset.invitedMembersHint": "Email addresses, one per tag. Press Enter, comma or space to add.",
  "pset.visibilitySave": "Save visibility",
  "pset.a2a": "A2A",
  "pset.agui": "AG-UI",
  "pset.agentCard": "Agent Card",
  "pset.apiToken": "API token",
  "pset.costLimits": "Cost limits",
  "pset.alertThreshold": "Alert threshold (USD)",
  "pset.alertThresholdHint": "Notify once a day, keep running",
  "pset.blockThreshold": "Block threshold (USD)",
  "pset.blockThresholdHint": "Refuse runs for the rest of the day",
  "pset.monthlyAlert": "Monthly alert threshold (USD)",
  "pset.monthlyAlertHint": "Notify once a month, keep running",
  "pset.monthlyBlock": "Monthly block threshold (USD)",
  "pset.monthlyBlockHint": "Refuse runs for the rest of the month",
  "pset.slackChannel": "Slack channel",
  "pset.slackChannelHint":
    "Where notifications are posted, using this project’s own bot. Without it the thresholds still block.",
  "pset.slackChannelUnavailable": "Enable the project bot and invite it to a channel first",
  "pset.notificationDestinations": "Notification destinations",
  "pset.notificationDestinationsHint":
    "Select an enabled integration to configure where it receives cost alerts.",
  "pset.slackBot": "Slack bot",
  "pset.appManifest": "App manifest",
  "pset.botToken": "Bot token",
  "pset.signingSecret": "Signing secret",
  "pset.signingSecretPlaceholder": "Signing secret from Basic Information",
  "pset.enableEvents": "Enable event handling at this URL",
  "pset.shortcutLabel": "Label",
  "pset.shortcutSends": "What clicking it sends",
  "pset.telegramBot": "Telegram bot",
  "pset.telegramIntro":
    "Create a bot with @BotFather, paste its token here and save — the token is checked with Telegram and the bot's username is learned from it. Enabling registers the webhook at this deployment and disabling removes it; Register webhook re-points it after a URL change. In a private chat the bot answers every message; in a group it answers when mentioned or replied to.",
  "pset.telegramEnable": "Enable message handling at this URL",
  "pset.telegramRegisterWebhook": "Register webhook",
  "pset.telegramWebhookRegistered": "Webhook registered at",
  "pset.telegramGroupHint":
    "In a group the bot answers only a message that mentions it or replies to one of its own; BotFather's privacy mode can stay on.",
  "pset.teamsBot": "Microsoft Teams bot",
  "pset.teamsIntro":
    "Register an Azure Bot (Bot Framework) with the Teams channel enabled, paste its Microsoft App ID and client secret here, and set the bot's messaging endpoint in Azure to the URL below. In a personal chat the bot answers every message; in a channel or group chat it answers when @mentioned. Test connection acquires a token with the stored credentials.",
  "pset.teamsAppId": "Microsoft App ID",
  "pset.teamsAppPassword": "Client secret",
  "pset.teamsTenantId": "Tenant id (single-tenant apps only)",
  "pset.teamsEnable": "Enable message handling at this endpoint",

  // The project webhook and schedules — the two ways something outside the
  // console starts a run.
  "webhook.section": "Webhook",
  "webhook.intro":
    "One address per project, off until you turn it on. An outside system starts a run by posting JSON to it with the secret in the X-Trigger-Secret header; the delivery is acknowledged immediately and its outcome lands in the history below. The webhook always runs the project's published version.",
  "schedule.section": "Schedules",
  "schedule.intro":
    "A cron expression in a timezone, fired without anyone asking. Schedules always run the project's published version, and their outcomes show up under each one.",
  "trigger.newId": "New schedule id",
  "trigger.newIdPlaceholder": "nightly-report",
  "trigger.cron": "Cron",
  "trigger.cronPlaceholder": "30 9 * * 1-5",
  "trigger.cronHint": "minute hour day-of-month month day-of-week",
  "trigger.timezone": "Timezone",
  "trigger.timezonePlaceholder": "Asia/Seoul",
  "trigger.message": "Message",
  "trigger.messagePlaceholder": "What each firing asks the project",
  "trigger.enabled": "Enabled",
  "trigger.allowOverlap": "Allow overlapping runs",
  "trigger.payload": "Payload",
  "trigger.destinations": "Report destinations",
  "trigger.destinationType": "Destination",
  "trigger.addDestination": "Add destination",
  "trigger.removeDestination": "Remove",
  "trigger.slackChannel": "Slack channel",
  "trigger.slackUnavailable": "Slack channels could not be loaded. Configure and enable the project bot first.",
  "trigger.telegramChatId": "Telegram chat id",
  "trigger.telegramChatIdHint": "You can also enter a chat id manually.",
  "trigger.telegramThreadId": "Telegram topic id (optional)",
  "trigger.telegramObservedDestination": "Observed Telegram destination",
  "trigger.telegramObservedDestinationHint": "Chats and topics appear after this bot receives a message from them.",
  "trigger.telegramObservedDestinationPlaceholder": "Select a chat or topic",
  "trigger.teamsConversationId": "Teams conversation id",
  "trigger.teamsConversationIdHint": "This bot setup cannot list Teams conversations; enter the target conversation id.",
  "trigger.destinationHint": "Select an available integration to configure its destination.",
  "trigger.saveScheduleSettings": "Save",

  // The admin pages, the profile, and the per-project usage tab.
  "admin.adminOnlyAudit": "Audit events are available to admins only.",
  "admin.adminOnlyMembers": "Members are available to admins only.",
  "models.memberOnly": "Models are available from the member tier up.",
  "audit.lede": "Sensitive administrative actions, newest first.",
  "audit.empty": "No audit events in this range.",
  "members.lede": "People who have signed in to this workspace.",
  "members.empty": "No members yet.",
  "members.lastLogin": "Last login",
  "members.neverRecorded": "Never recorded",
  "models.lede":
    "Which LLM providers this deployment reaches, and which models users may pick for their agents.",
  "models.filter": "Filter models…",
  "models.catalogUpdated": "catalog updated",
  "models.refreshNow": "Refresh now",
  "models.catalogFile.title": "Catalog document",
  "models.catalogFile.lede":
    "A catalog JSON installed here is the registry, ahead of the published catalog — for a deployment without a route to it. Remove it to follow the published catalog again.",
  "models.catalogFile.none":
    "No document is installed; the registry follows the published catalog or the built-in snapshot.",
  "models.catalogFile.installed":
    "Installed by {by} on {at} — {count} models, catalog updated {updated}",
  "models.catalogFile.skipped": "{count} entries the registry refuses",
  "models.catalogFile.choose": "Catalog JSON",
  "models.catalogFile.upload": "Install",
  "models.catalogFile.remove": "Remove",
  "models.selfHosted.title": "Self-hosted models",
  "models.selfHosted.lede":
    "Models this deployment serves itself, declared here and dispatched through the selfhosted channel. The list is what the channel reports; a declared model joins the registry at zero price.",
  "models.selfHosted.servedBy": "served by the channel",
  "models.selfHosted.notServed": "not served",
  "models.selfHosted.notServedHint":
    "The channel does not list this name right now — a run will fail until it is served again.",
  "models.selfHosted.notInstalled": "not installed",
  "models.selfHosted.notInstalledHint":
    "Stored, but not installed in this instance's registry — a name the published catalog also carries, or, right after saving, a replica that has not run its next catalog tick. A refusal's reason is in the server log.",
  "models.selfHosted.empty": "The channel serves no models right now.",
  "models.selfHosted.declare": "Declare",
  "models.selfHosted.remove": "Remove",
  "models.selfHosted.cancel": "Cancel",
  "models.selfHosted.displayName": "Display name",
  "models.selfHosted.context": "Context window",
  "models.selfHosted.maxOutput": "Max output",
  "models.promoTooltip":
    "Promotional rate at the route's default endpoint, already applied — list price {list}",
  "models.reasoningNoTools":
    "Not alongside tools: the provider rejects the pair, so agent runs force the effort to none",
  "models.cached": "cached",
  "models.empty": "No models are registered.",
  "profile.lede": "Your account, and your own usage across every project.",
  "profile.tierLimits": "Tier limits",
  "profile.monthlyCap": "Monthly cap",
  "settings.lede":
    "Overrides are stored in the database and take precedence over environment variables. Masked values keep the stored secret; clear a field to fall back to env.",
  "settings.keepPrefix": "keep prefix",
  "settings.artifactAccess.authenticated": "Authenticated · presigned URL",
  "settings.artifactAccess.public": "Public · direct S3 URL",
  "settings.artifactAccess.proxied": "Proxied · served by this app",
  "settings.providerPlaceholder": "provider…",
  "settings.baseUrlPlaceholder": "base URL",
  "settings.clientName": "Client name",
  "settings.clientNamePlaceholder": "partner-batch",
  "settings.optional": "optional",
  "apiRef.request": "Request",
  "apiRef.response": "Response",
  "projectArtifacts.empty": "This project has not produced anything yet.",
  "projectUsage.empty": "No usage recorded in this range.",
  "projectUsage.callers": "Callers",
  "projectUsage.whoSpent": "Who spent it",
  "versions.empty": "No versions yet. Create one in the Playground tab.",
} as const;

export type MessageKey = keyof typeof en;

/** The shape `ko.ts` has to satisfy: every key above, mapped to a string. */
export type Messages = Record<MessageKey, string>;
