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
    "Author a prompt, an agent, or an image project, iterate in versions, publish one — then call it from the console, an OpenAI-compatible API, Slack, a webhook, or another agent. Every run attributed, priced, and bounded.",
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

  // Chats: the sidebar, the thread, the composer and the parts a turn is drawn
  // from.
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
  "chat.thinking": "Thinking…",
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

  // One project's header and tab strip.
  "project.badge": "AI project",
  "project.lede": "Design, test, and observe this project from one workspace.",
  "project.ownedBy": "Owned by ",
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
    "SSM parameter names, not values — the secrets never pass through here.",
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
    "How other systems reach this project — the token an API caller presents, the chat platforms whose bots run it, and its A2A exposure. What the project itself is, its cost limits and its triggers stay under Settings.",
  "pint.ownerOnly": "Only the project owner ({owner}) or an admin can change these integrations.",

  // A project's settings tab: the sections and their forms.
  "pset.dangerZone": "Danger zone",
  "pset.a2a": "A2A",
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
  "models.empty": "No models are registered.",
  "profile.lede": "Your account, and your own usage across every project.",
  "profile.tierLimits": "Tier limits",
  "profile.monthlyCap": "Monthly cap",
  "settings.lede":
    "Overrides are stored in the database and take precedence over environment variables. Masked values keep the stored secret; clear a field to fall back to env.",
  "settings.keepPrefix": "keep prefix",
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
