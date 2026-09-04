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
 *
 * **Operator maintenance surfaces may stay English** — the tools detail page,
 * integration sections, and similar admin-only screens whose action buttons
 * ("Save", "Test connection", "Disconnect") sit beside English error text and
 * API vocabulary anyway. That is a policy, not drift: a screen is either in
 * this catalogue or it is not, and a screen being migrated should move whole,
 * never one label at a time.
 */
export const en = {
  // Language toggle. Each language is named in itself — `LOCALE_LABELS` — so
  // only the control around it is translated.
  "locale.label": "Language",
  "locale.change": "Change language",

  // Colour-scheme toggle.
  "theme.current": "Theme: {name}",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",

  // App chrome: the header, the sidebar and its groups.
  "chrome.tagline": "Self-hosted agent platform",
  "chrome.navLabel": "Workspace navigation",
  "chrome.openNavigation": "Open navigation",
  "chrome.closeNavigation": "Close navigation",
  "chrome.openProjects": "Open projects",
  "chrome.status": "Workspace online · v{version}",
  "nav.group.workspace": "Workspace",
  "nav.group.intelligence": "Registries",
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
  "auth.signInFailed": "Sign-in did not start. Try again.",
  "auth.or": "or",
  "auth.signOut": "Sign out",
  "auth.account": "Account",
  "login.title": "Sign in to continue",
  "login.product": "Agent Studio, a self-hosted platform for building and running agents.",
  "login.domains": "Use an account on one of this deployment’s allowed domains.",

  // The signed-out landing page.
  "home.eyebrow": "Project · version · publish",
  "home.headline": "Build AI agents",
  "home.headlineAccent": " and run them on your own servers.",
  "home.lede":
    "Agent Studio runs inside your company's network. Create prompt, agent, and image projects, publish a version, and use it from the console, an API, a chat platform, or another agent. The core app, including sign-in and runs, keeps working without public internet access.",
  "home.signInHint": "Sign in with an account from an allowed domain.",
  "home.proof.network": "Runs on your servers",
  "home.proof.networkNote": "PostgreSQL and an OpenAI-compatible model endpoint",
  "home.proof.engine": "One interface for your models",
  "home.proof.engineNote": "Use a router, self-hosted models, or provider APIs",
  "home.proof.cost": "Cost and traces per run",
  "home.proof.costNote": "Attributed to the caller that started the run",
  "home.streamLabel": "Example of an agent run stream",
  "home.streamCaption": "agent run · text/event-stream",
  "home.streamLive": "example",
  "home.coverage": "What Agent Studio covers",
  "home.domain.projects": "Projects & versions",
  "home.domain.projectsBody":
    "Manage a prompt, agent, or image workload as a project. Save its settings as named versions; callers use the published version unless they request a specific one.",
  "home.domain.agent": "Agent loop",
  "home.domain.agentBody":
    "An agent can load skills, call MCP tools, delegate to subagents, and read URLs. Turn and context limits keep each run bounded.",
  "home.domain.mcp": "MCP tools",
  "home.domain.mcpBody":
    "Register a server once, then bind it to any version. Each binding can limit the available tools and override outbound headers. Project-specific OAuth is supported, and secrets are encrypted at rest.",
  "home.domain.skills": "Skills",
  "home.domain.skillsBody":
    "Reusable instructions written in Markdown. The model sees a short list of names and descriptions, then loads the full instructions when needed.",
  "home.domain.plugins": "Agent Plugins",
  "home.domain.pluginsBody":
    "Sync skills and MCP servers from a plugin repository. In an air-gapped installation, upload an archive of the same repository instead.",
  "home.domain.catalog": "Capability catalog",
  "home.domain.catalogBody":
    "Search skills, MCP tools, and agents in one catalog. An opted-in version adds relevant capabilities for the current run without changing its saved bindings.",
  "home.domain.chats": "Chats",
  "home.domain.chatsBody":
    "Talk to a published agent in the console. Attach images and documents, follow the streamed reply, and inspect tool calls in the conversation. Closing the tab does not stop the run.",
  "home.domain.images": "Images",
  "home.domain.imagesBody":
    "Generate or edit images with an image project, an agent's built-in tools, or an image subagent. An agent can edit an attached image or one produced earlier in the run.",
  "home.domain.artifacts": "Artifacts",
  "home.domain.artifactsBody":
    "Keep images and files produced by runs behind signed URLs, and browse them by project or by user.",
  "home.domain.surfaces": "Slack, A2A & webhooks",
  "home.domain.surfacesBody":
    "Connect agent projects to Slack, Telegram, and Teams. Published versions can also run from webhooks, schedules, and inbound or outbound A2A calls.",
  "home.domain.cost": "Cost & guards",
  "home.domain.costBody":
    "Record each run's cost and summarize it by project, caller, and day. Daily and monthly thresholds can send an alert or block new runs.",
  "home.domain.traces": "Traces & audit",
  "home.domain.tracesBody":
    "Inspect each run turn by turn, including tool calls. Secret access, administrative changes, and deletions are recorded in the audit log.",
  "home.install.title": "Installing it",
  "home.install.body":
    "Agent Studio is distributed as a container image. Environment repositories own deployment manifests; this repository contains the local development setup.",
  "home.install.floor": "What it needs",
  "home.install.floorNote":
    "Provide PostgreSQL with pgvector and an OpenAI-compatible model endpoint. The app creates its database schema when it starts.",
  "home.install.offline": "Without internet access",
  "home.install.offlineNote":
    "Upload model catalogs and plugin archives, mirror container images to an internal registry, and use a self-hosted embedding endpoint.",
  "home.install.optional": "What stays optional",
  "home.install.optionalNote":
    "Slack, Telegram, Teams, outbound A2A, and external model APIs are independent integrations. If one is not configured, only that integration stays off.",
  "home.product": "A self-hosted platform for building and running agents.",

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
    "Create prompt, agent, and image projects, test them in the console, and publish them for other systems to use.",
  "overview.newProject": "New project",
  "overview.newChat": "New chat",
  "overview.recentProjects": "Recent projects",
  "overview.recentProjectsNote": "Your projects come first, followed by other recently updated projects.",
  "overview.allProjects": "All projects",
  "overview.projectsFailed": "Projects could not be loaded.",
  "overview.noProjects": "No projects yet.",
  "overview.recentChats": "Recent chats",
  "overview.recentChatsNote": "Continue a conversation where you left off.",
  "overview.allChats": "All chats",
  "overview.noChats": "No chats yet.",
  "overview.getStarted": "Start with a project",
  "overview.getStartedBody":
    "Create a project, configure its first version in the Playground, and run it there. Agent projects can use skills and MCP tools, and a published agent is also available in Chats.",
  "overview.browseSkills": "Browse skills",

  // The guide page: what this console is for, and the shortest path through it.
  // Longer prose than anywhere else here, and deliberately so — it is the one
  // page whose content *is* the text.
  "guide.title": "Guide",
  "guide.lede":
    "Start here if you are new to Agent Studio. This guide covers the path from creating a project to publishing and connecting it, then explains the terms and limits you will see along the way.",

  "guide.start.title": "If this is your first time",
  "guide.start.body":
    "The usual path is to create a project, configure and test a version, publish it, and then connect a caller. Publishing chooses the default version; a caller can still request another saved version by name.",
  "guide.start.step1": "Create a project",
  "guide.start.step1Body":
    "Open Projects and select New project. Choose llm, agent, or image, and enter the permanent identifier that callers will use.",
  "guide.start.step2": "Configure a version in the Playground",
  "guide.start.step2Body":
    "Choose the model, prompts, limits, and capabilities for the version. Save it and use the run panel beside the editor to test it. You can keep editing and saving the same version.",
  "guide.start.step3": "Publish the version",
  "guide.start.step3Body":
    "Publishing makes this version the project's default. Requests for the published version use it immediately, while requests for a specific version continue to use the version they named.",
  "guide.start.step4": "Connect a caller",
  "guide.start.step4Body":
    "Use the examples on the API Reference tab to call the project over HTTP. The Integrations tab provides the project token and setup details for Slack, Telegram, Teams, A2A, and AG-UI.",

  "guide.words.title": "Words this console uses",
  "guide.words.project": "Project",
  "guide.words.projectBody":
    "A named unit of work with one type. A project contains its versions, access rules, cost limits, and integrations.",
  "guide.words.version": "Version",
  "guide.words.versionBody":
    "A named configuration containing the model, prompts, tools, and run limits. Saving updates that version in place. If it is published, the next run uses the updated configuration. Publishing marks one version as the project default.",
  "guide.words.run": "Run",
  "guide.words.runBody":
    "One execution of a version. A run records its caller, deadline, usage, cost, and trace.",
  "guide.words.caller": "Caller",
  "guide.words.callerBody":
    "The identity that started a run, such as a console user, project token, or Slack user. Cost is recorded for both the project and caller, while the concurrency limit applies to the caller.",
  "guide.words.tier": "Tier",
  "guide.words.tierBody":
    "Your access level: guest, member, or admin. It controls project creation, API tokens, concurrent runs, and monthly spend. The Profile page shows the limits that apply to you.",

  "guide.types.title": "Three kinds of project",
  "guide.types.llm": "llm: one prompt, one answer",
  "guide.types.llmBody":
    "Fills {{variables}} in a prompt template and returns one model response. It does not use tools or continue to another turn.",
  "guide.types.agent": "agent: a multi-turn tool loop",
  "guide.types.agentBody":
    "Runs a multi-turn tool loop until the model finishes its answer. Depending on the version, it can load skills, call MCP tools, delegate work, generate images, and read URLs.",
  "guide.types.image": "image: draw or edit pictures",
  "guide.types.imageBody":
    "Generates an image from a prompt or edits an attached image. Image-capable surfaces such as the Playground, predict API, AG-UI, and A2A return the image itself. Chats accepts agent projects only, and chat completion endpoints reject image projects.",

  "guide.reach.title": "What a version can use",
  "guide.reach.body":
    "A version's bindings and settings decide most of what it can use; the deployment must also provide the underlying capability. If an enabled capability is unavailable during a run, the run reports a warning.",
  "guide.reach.skills": "Skills",
  "guide.reach.skillsBody":
    "Reusable instructions written in Markdown. The model sees each skill's name and description, then loads the full content when needed. The Skills page lists what is available.",
  "guide.reach.tools": "MCP tools",
  "guide.reach.toolsBody":
    "Servers registered on the Tools page. A version binds a server, chooses which tools to expose, and can override outbound headers. Secrets are encrypted at rest.",
  "guide.reach.subagents": "Subagents",
  "guide.reach.subagentsBody":
    "Another project or an external agent that can receive delegated work. Subagent output is labelled with its author, and its cost remains attributed to the original caller.",
  "guide.reach.catalog": "Capability catalog",
  "guide.reach.catalogBody":
    "A searchable index of skills, MCP tools, and external agents. When dynamic discovery is enabled, each run adds relevant results to its resolved bindings for that run only. Saved bindings are neither removed nor changed.",
  "guide.reach.builtins": "Built-in tools",
  "guide.reach.builtinsBody":
    "A version can enable image generation, URL reading, and Slack history. SaveFile is available automatically when artifact storage is configured, so an agent can give the reader a downloadable text file.",
  "guide.reach.memory": "Memory",
  "guide.reach.memoryBody":
    "A version can ask bound MCP servers with a recall tool for relevant memory before the first model response. If no bound server offers recall, the run continues without memory and reports a warning.",

  "guide.surfaces.title": "Where it can answer",
  "guide.surfaces.body":
    "Every surface uses the same execution engine and records usage and traces in the same place. External callers normally use the published version; the Playground runs the version currently open in the editor.",
  "guide.surfaces.console": "The console",
  "guide.surfaces.consoleBody":
    "Use the Playground while configuring and testing a version. Use Chats for ongoing conversations with published agent projects, including attachments and tool calls. Closing the browser tab does not stop an active chat run.",
  "guide.surfaces.http": "HTTP",
  "guide.surfaces.httpBody":
    "The API Reference tab documents three endpoints that accept the project token. Predict supports each project type, chat completions supports llm and agent projects, and the agent endpoint streams an agent's text and tool activity.",
  "guide.surfaces.chatbots": "Slack, Telegram, Teams",
  "guide.surfaces.chatbotsBody":
    "An agent project can connect one bot on each supported platform from the Integrations tab. Direct-message and channel activation rules differ by platform, but each connection preserves conversation context and streams or updates the reply in the platform's supported format.",
  "guide.surfaces.triggers": "Webhooks and schedules",
  "guide.surfaces.triggersBody":
    "The Settings tab provides one webhook and any number of cron schedules. Both run the published version, and their execution history appears on the same tab.",
  "guide.surfaces.a2a": "A2A",
  "guide.surfaces.a2aBody":
    "The Integrations tab shows this project's A2A exposure status and Agent Card URL. To call another A2A agent, register it on the Agents page and bind it to an agent project version.",
  "guide.surfaces.agui": "AG-UI",
  "guide.surfaces.aguiBody":
    "Use AG-UI to run a published project inside your own application. The client sends its thread and receives protocol events that the application can render in its own interface.",

  "guide.limits.title": "Cost, limits, and records",
  "guide.limits.cost": "Every run is priced",
  "guide.limits.costBody":
    "A run uses the cost reported by its model channel, or the model registry price when none is reported. The overview shows workspace usage, the project's Usage tab shows project and caller details, and Profile shows your own spend.",
  "guide.limits.guards": "Thresholds alert, then refuse",
  "guide.limits.guardsBody":
    "Configure daily and monthly project limits on the Settings tab. An alert threshold sends one notification and lets runs continue. A block threshold rejects new runs until the period resets at UTC midnight or the start of the next month.",
  "guide.limits.tier": "Your tier applies too",
  "guide.limits.tierBody":
    "Your tier can set a monthly cost cap across all projects and a limit on concurrent runs. Profile shows both values, and an admin can change your tier.",
  "guide.limits.records": "What a run leaves behind",
  "guide.limits.recordsBody":
    "The project's Traces tab records turns and tool calls. Images and files produced by runs appear under Artifacts: your own in the sidebar page, and all project output in the project's Artifacts tab.",

  "guide.trouble.title": "When something does not work",
  "guide.trouble.refused": "A run was refused over cost",
  "guide.trouble.refusedBody":
    "The project reached a daily or monthly block threshold, or your tier reached its monthly cap. A project owner or admin can change project limits in Settings; only an admin can change a member's tier.",
  "guide.trouble.model": "The model I want is missing",
  "guide.trouble.modelBody":
    "The Models page lists the models available to this deployment, and only an admin can change that selection. If the deployment allows unknown model IDs, they can still be sent to the provider but are recorded at zero cost because the registry has no price for them. A deployment configured to refuse unknown models stops the run instead.",
  "guide.trouble.tool": "The model never calls my MCP tool",
  "guide.trouble.toolBody":
    "Check the version's MCP binding first. If it names specific tools, all others are hidden. Then use the Tools page to confirm that discovery succeeds. A run that cannot reach a bound server reports a warning.",
  "guide.trouble.slack": "The Slack bot stays silent",
  "guide.trouble.slackBody":
    "The bot answers mentions, direct messages, follow-ups in threads it joined, and channel messages that match configured keywords. Use Test connection on the Integrations tab to validate the bot token. Channel selectors in Settings list channels only after the enabled bot has joined them.",
  "guide.trouble.tab": "I closed the tab while it was answering",
  "guide.trouble.tabBody":
    "The run continues. Open that conversation again in Chats and the answer is there.",

  "guide.more.title": "Where to read more",
  "guide.more.body":
    "Each project's API Reference tab explains how to call that project. The source tree also includes offline documentation for installation, configuration, security, and operations under docs/ (INSTALL.md, CONFIGURATION.md, SECURITY.md, OPERATIONS.md).",

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
  "projects.departmentHint": "Optional code for grouping project ownership and costs.",
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
  "version.invalidJson": "Enter a JSON object",
  "version.model": "Model",
  "version.selectModel": "Select a model…",
  "version.modelUnlisted":
    "Model is unavailable for new selection. A hidden model keeps running; a removed model may be recorded with $0 cost.",
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
  "run.images": "Attachments",
  "run.sourceImages": "Source images",
  "run.attachHintEdits": "The prompt edits these images.",
  "run.attachHintGenerate": "Attach an image to edit it instead of generating a new one.",
  "run.attachHintLook": "Images and readable documents are sent with the run.",
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

  // The full-screen image viewer every surface opens a picture in. Its own
  // namespace rather than `artifacts.`: the gallery is one of four callers.
  "viewer.showInfo": "Show details",
  "viewer.hideInfo": "Hide details",
  "viewer.copyPrompt": "Copy prompt",
  "viewer.close": "Close",

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
  "members.member": "Member",
  "members.tier": "Tier",
  "members.joined": "Joined",
  "members.lastLogin": "Last login",
  "members.neverRecorded": "Never recorded",
  "models.lede":
    "Text, image, embedding, rerank, and transcription models available through this deployment's AI providers.",
  "models.filter": "Filter models…",
  "models.type": "Model type",
  "models.allTypes": "All types",
  "models.type.text": "Text",
  "models.type.image": "Image",
  "models.type.embedding": "Embedding",
  "models.type.rerank": "Rerank",
  "models.type.transcription": "Transcription",
  "models.selection.title": "Active retrieval models",
  "models.selection.lede":
    "Choose the registered model used for capability embedding and second-stage reranking. Environment variables remain the deployment defaults.",
  "models.selection.unconfigured": "Not configured",
  "models.selection.embeddingConfirmTitle": "Migrate capability vectors",
  "models.selection.embeddingConfirmMessage":
    "Changing the embedding model rebuilds every stored capability vector. Dynamic discovery may be unavailable until the migration finishes; a failed migration restores the previous selection and index.",
  "models.selection.migrate": "Migrate",
  "models.selection.migrated": "Selected and rebuilt {count} capability vectors.",
  "models.selection.saved": "Model selection saved.",
  "models.selection.failed": "Failed to change the model",
  "models.selection.rerankerMinScore": "Minimum relevance score",
  "models.selection.rerankerMinScoreHint": "Tune this for the selected rerank model (0–1).",
  "models.selection.saveScore": "Save score",
  "models.favorites": "Favorites",
  "models.favorite": "Add to favorites",
  "models.unfavorite": "Remove from favorites",
  "models.favoriteSaveFailed": "Failed to save favorites",
  "models.hidden": "Hidden",
  "models.hideModel": "Hide {model}",
  "models.hiddenCount": "{count} hidden",
  "models.showAll": "Show all",
  "models.oneVisible": "At least one model must remain visible.",
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
  "models.selfHosted.edit": "Edit",
  "models.selfHosted.save": "Save",
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
  "profile.lede": "Your account and usage across all projects.",
  "profile.tierLimits": "Tier limits",
  "profile.monthlyCap": "Monthly cost limit",
  "profile.joined": "Joined",
  "profile.concurrentRun": "{count} concurrent run",
  "profile.concurrentRuns": "{count} concurrent runs",
  "profile.workspaceConcurrency": "Workspace default concurrency",
  "profile.perMonth": "{amount}/month",
  "profile.uncapped": "uncapped",
  "profile.capPeriod": "Current UTC month, independent of the selected range",
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
  "projectUsage.whoSpent": "Usage by caller",
  "projectUsage.ownerAdminOnly": "Visible to owners and admins",
  "projectUsage.distinctIdentities": "Unique callers",
  "projectUsage.unavailable": "Caller details unavailable",
  "projectUsage.perCallerRange": "Per caller in the selected range",
  "projectUsage.topCallersRange": "Top {count} callers by cost in the selected range",
  "projectUsage.caller": "Caller",
  "versions.empty": "No versions yet. Create one in the Playground tab.",
  "versions.published": "Published",
  "versions.publish": "Publish",
  "versions.delete": "Delete",
  "versions.deleteTitle": "Delete version",
  "versions.deleteBody": "Delete version v{name}? This cannot be undone.",
} as const;

export type MessageKey = keyof typeof en;

/** The shape `ko.ts` has to satisfy: every key above, mapped to a string. */
export type Messages = Record<MessageKey, string>;
