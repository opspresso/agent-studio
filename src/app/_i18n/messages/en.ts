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
  "workspace.new": "New Workspace",
  "workspace.kind": "Workspace",
  "workspace.list": "Workspaces",
  "workspace.delete": "Delete Workspace",
  "workspace.intro": "Keep files and agent context across tasks.",
  "workspace.notConfigured": "No Workspace projects are configured for your account.",
  "workspace.repository": "Repository",
  "workspace.runtime": "Runtime",
  "workspace.command": "Command / script",
  "workspace.useRepository": "Use a Git repository",
  "workspace.baseBranch": "Base branch",
  "workspace.script": "Script",
  "workspace.task": "Task",
  "workspace.taskHint": "Ctrl/⌘ + Enter to start.",
  "workspace.start": "Start workspace",
  "workspace.finish": "Finish workspace",
  "workspace.runs": "Recent runs",
  "workspace.output": "Live output",
  "workspace.checks": "Checks",
  "workspace.actions": "Git & deployment",
  "workspace.request": "Request",
  "workspace.queuedHint": "Queued. The Workspace worker will start this task.",
  "workspace.runningHint": "Working in Sandbox…",
  "workspace.outputWindow": "Showing a bounded output window. Earlier output may be omitted.",
  "workspace.noOutput": "Waiting for output.",
  "workspace.noDiff": "No uncommitted changes in this run.",
  "workspace.noChecks": "No test, lint or build commands are configured for this project.",
  "workspace.diffTruncated": "This diff preview is truncated. The approval is bound to the complete file tree.",
  "workspace.exitCode": "Exit code",
  "workspace.latest": "Latest",
  "workspace.followUp": "Continue this workspace…",
  "workspace.scriptPlaceholder": "Enter the next script…",
  "workspace.sessionHint": "Files and Session stay with this Workspace.",
  "workspace.stop": "Stop run",
  "workspace.send": "Send",
  "workspace.pendingActionHint": "Review the pending action in Git & deployment.",
  "workspace.pendingEditHint": "A new task cancels the pending Git review. Review the updated changes again before publishing.",
  "workspace.reviewAction": "Review before approval",
  "workspace.reviewHint": "Confirm the exact request and changes. Git and deployment actions require your approval.",
  "workspace.approve": "Approve and execute",
  "workspace.reject": "Reject",
  "workspace.action": "Action",
  "workspace.merge": "Merge PR into main",
  "workspace.deploy": "Run deployment workflow",
  "workspace.commitMessage": "Commit message",
  "workspace.prTitle": "PR title",
  "workspace.prBody": "PR description",
  "workspace.mergeHint": "Merge this PR’s reviewed head into main. Pending or failed checks block merging; GitHub branch rules still apply.",
  "workspace.pushMain": "Push to main",
  "workspace.pushMainHint": "Publish the committed, pushed work branch directly to main, without a PR. Only fast-forward updates are allowed; GitHub branch rules still apply.",
  "workspace.noCi": "No CI checks have been reported for this commit. This is not a passing CI result. Approving publishes without CI evidence unless GitHub branch rules reject it.",
  "workspace.workflow": "Workflow",
  "workspace.workflowInputs": "Workflow inputs (JSON)",
  "workspace.deployHint": "Runs the configured workflow on main. Deployment credentials stay in CI/CD.",
  "workspace.prepareAction": "Prepare review",
  "workspace.actionInProgress": "The previous action is running or awaiting reconciliation.",
  "workspace.status.active": "Active",
  "workspace.status.suspending": "Saving & suspending",
  "workspace.status.suspended": "Suspended",
  "workspace.status.closing": "Finishing",
  "workspace.status.closed": "Finished",
  "workspace.status.queued": "Queued",
  "workspace.status.running": "Running",
  "workspace.status.succeeded": "Succeeded",
  "workspace.status.failed": "Failed",
  "workspace.status.cancelled": "Stopped",
  "workspace.status.interrupted": "Interrupted",
  "workspace.status.pending": "Pending",
  "workspace.status.passed": "Passed",
  "workspace.status.skipped": "Skipped",
  "workspace.status.approved": "Approved",
  "workspace.status.rejected": "Rejected",
  "workspace.status.executing": "Executing",
  "workspace.status.uncertain": "Result uncertain",
  "audio.uploadedFile": "Uploaded original",
  "audio.title": "Audio processing",
  "audio.useSaved": "Use saved project settings",
  "audio.configRevision": "Settings revision",
  "audio.configDisabled": "New jobs are disabled. Enable and save the project settings to resume submissions.",
  "audio.projectConfig": "Project job settings",
  "audio.configEnabled": "Allow new jobs and retries",
  "audio.maxActive": "Maximum queued and running jobs",
  "audio.maxPerOccurrence": "Maximum new jobs per run",
  "audio.saveConfig": "Save project settings",
  "audio.saveConfigHint": "Save the selected processing options and limits for future jobs. Existing jobs keep their submitted settings.",
  "audio.pageHint": "Upload audio, follow background transcription and postprocessing, and reopen the results in private Artifacts.",
  "audio.file": "Audio file",
  "audio.chooseFile": "Choose a file",
  "audio.model": "Transcription model",
  "audio.language": "Transcription language code (optional)",
  "audio.noModels": "No transcription models are configured. Ask an administrator to configure a transcription endpoint and model.",
  "audio.retention": "Keep original for",
  "audio.retentionUnit": "Period unit",
  "audio.days": "Days",
  "audio.months": "Calendar months",
  "audio.timezone": "Timezone",
  "audio.writer": "Postprocessing Agent (optional)",
  "audio.writerVersion": "Agent version",
  "audio.followPublished": "Follow published version",
  "audio.writerVersionHint": "The selected version is fixed when a job is submitted. New publications apply only to new jobs.",
  "audio.destination": "Memory destination (optional)",
  "audio.destinationHint": "Choose an MCP server bound to this project’s published version.",
  "audio.saveDocuments": "Save documents",
  "audio.saveMemories": "Save grounded memories",
  "audio.personalOnly": "Originals and results are private Artifacts. Accepted jobs continue after you leave.",
  "audio.submit": "Start processing",
  "audio.jobs": "Processing jobs",
  "audio.refresh": "Refresh",
  "audio.noJobs": "No audio jobs yet.",
  "audio.original": "Original file",
  "audio.transcript": "Transcript",
  "audio.dialogue": "Dialogue",
  "audio.toolsRequired": "Enable audio processing tools in the published version to use this page. Before the first publication, the latest saved version is used.",
  "audio.result": "Processed result",
  "audio.delete": "Delete job",
  "audio.deleteTitle": "Delete processing job?",
  "audio.deleteBody": "Delete this job history and allow the same recording to be submitted again. Original files, transcripts and saved results keep their retention period. This does not start a new job; request import or transcription again after deletion.",
  "audio.retry": "Retry",
  "audio.resumeAt": "Next processing attempt",
  "audio.expiresAt": "Original expires",
  "audio.updatedAt": "Last progress update",
  "audio.createdAt": "Submitted",
  "audio.attempt": "Worker attempts: {count}",
  "audio.completedSegments": "{count} segments completed",
  "audio.completedParts": "{count} / {total} completed",
  "audio.round": "Round {count}",
  "audio.postprocess.extract": "Extracting transcript sections",
  "audio.postprocess.reduce": "Combining extracted results",
  "audio.postprocess.saving": "Saving output files",
  "audio.activity.importing": "Preparing and storing the source file.",
  "audio.activity.transcribing": "Transcribing audio. Progress updates after each segment completes.",
  "audio.activity.postprocessing": "Processing the transcript with the Agent. Counts update after each section completes; combining results may take multiple rounds.",
  "audio.activity.storing": "Delivering results and checking the destination processing status.",
  "audio.activity.cleaning": "Removing intermediate files. Final output files are retained.",
  "audio.queuedHint": "Waiting for a worker to start this job.",
  "audio.retryHint": "A processing error occurred. Waiting for an automatic retry.",
  "audio.deliveryWaitHint": "Waiting for the destination to finish processing the documents.",
  "audio.pollingHint": "Active jobs refresh every 5 seconds while this tab is visible. Progress bars apply to their labeled phase, not the whole job.",
  "audio.task.import": "Import file",
  "audio.task.transcribe": "Transcribe audio",
  "audio.task.postprocess": "Process transcript",
  "audio.task.process": "Process audio",
  "audio.coverage": "Transcribed audio",
  "audio.seconds": "seconds",
  "audio.receipts": "Saved record IDs",
  "audio.receiptsHint": "A document ID confirms receipt. The job completes after all selected documents finish processing and memories are saved.",
  "audio.cancel": "Cancel",
  "audio.more": "Load more",
  "audio.status.queued": "Queued",
  "audio.status.running": "Running",
  "audio.status.waiting": "Waiting to resume",
  "audio.status.completed": "Completed",
  "audio.status.failed": "Failed",
  "audio.status.blocked": "Needs attention",
  "audio.status.cancelled": "Cancelled",
  "audio.stage.importing": "Importing",
  "audio.stage.transcribing": "Transcribing",
  "audio.stage.postprocessing": "Agent processing",
  "audio.stage.storing": "Saving",
  "audio.stage.cleaning": "Cleaning intermediate files",
  "audio.moved": "Documents copied to",
  "audio.enableTools": "Audio processing tools",
  "audio.enableToolsHint": "Let this Agent import files, transcribe audio and inspect background jobs.",
  "audio.runAsOwner": "Run with my personal context",
  "audio.runAsOwnerHint": "Use your verified email for personal MCP data. Only the project owner can enable this.",
  "audio.mappingTitle": "File response mappings",
  "audio.mappingDefaults": "Plugin defaults apply automatically when available. No manual mapping is needed for those servers.",
  "audio.mappingOverride": "This version overrides plugin defaults. An empty override disables file mapping.",
  "audio.useMappingDefaults": "Use plugin defaults",
  "audio.mappingHint": "Map a tool's JSON fields to private file references. Separate nested fields with dots. Use a distinct namespace for each account.",
  "audio.mappingTool": "Tool name",
  "audio.refreshArgument": "Read tool's item ID argument (optional)",
  "audio.refreshArgumentHint": "Replay this tool with the original item ID immediately before downloading. Use only a read tool requiring this single argument.",
  "audio.namespace": "Account namespace",
  "audio.urlPath": "Download URL field path",
  "audio.idPath": "File ID field path",
  "audio.namePath": "Filename field path (optional)",
  "audio.mimeType": "File MIME type",
  "audio.addMapping": "Add file mapping",
  "audio.removeMapping": "Remove mapping",
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
  "chrome.tagline": "Agent platform",
  "chrome.navLabel": "Workspace navigation",
  "chrome.openNavigation": "Open navigation",
  "chrome.skipToContent": "Skip to main content",
  "chrome.closeNavigation": "Close navigation",
  "chrome.openProjects": "Open projects",
  "chrome.status": "Version {version}",
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
  "login.product": "Agent Studio, a platform for building and using AI agents.",
  "login.domains": "Use an account on one of this deployment’s allowed domains.",

  // The signed-out landing page.
  "home.flow.title": "From an idea to a working agent",
  "home.flow.build": "Configure a project",
  "home.flow.buildBody": "Choose a model and instructions. Add skills and tools when your agent needs them.",
  "home.flow.run": "Publish and run",
  "home.flow.runBody": "Publish a version, then run it in the console, through an API, or a connected messenger.",
  "home.flow.review": "Review the results",
  "home.flow.reviewBody": "Return to conversations and artifacts. Inspect run traces and usage in the same workspace.",
  "home.eyebrow": "Project · version · publish",
  "home.headline": "Build AI agents",
  "home.headlineAccent": " and put them to work.",
  "home.lede":
    "Agent Studio brings models, skills, and tools together in one agent platform. Create prompt, agent, and image projects, then use them in conversations, through APIs, or from your favorite messengers.",
  "home.signInHint": "Sign in with an account from an allowed domain.",
  "home.proof.network": "From ideas to agents",
  "home.proof.networkNote": "Create, test, and publish in one workspace",
  "home.proof.engine": "One interface for your models",
  "home.proof.engineNote": "Connect the right model for each task",
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
    "Bring reusable skills and MCP tools into your projects from plugin repositories or uploaded archives.",
  "home.domain.catalog": "Capability catalog",
  "home.domain.catalogBody":
    "Search skills, MCP tools, and agents in one catalog. An opted-in version adds relevant capabilities for the current run without changing its saved bindings.",
  "home.domain.chats": "Chats",
  "home.domain.chatsBody":
    "Talk to an agent in the console. Read PDF, text, and Office attachments without a document MCP server, and follow replies and tool calls. Closing the tab does not stop the run.",
  "home.domain.images": "Images",
  "home.domain.imagesBody":
    "Generate or edit images with an image project, an agent's built-in tools, or an image subagent. An agent can edit an attached image or one produced earlier in the run.",
  "home.domain.audio": "Audio transcription & summaries",
  "home.domain.audioBody": "Import audio from uploads or connected tools, transcribe it with a selected model, and produce summaries in the background. Keep originals and results as private Artifacts; personal records are saved when requested.",
  "home.domain.artifacts": "Documents & artifacts",
  "home.domain.artifactsBody":
    "Create reports, presentations, and spreadsheets. Edit supported attachments into new files while keeping the originals. Configured storage keeps originals and results available for download.",
  "home.domain.surfaces": "Slack, A2A & webhooks",
  "home.domain.surfacesBody":
    "Connect agent projects to Slack, Telegram, and Teams. Published versions can also run from webhooks, schedules, and inbound or outbound A2A calls.",
  "home.domain.cost": "Cost & guards",
  "home.domain.costBody":
    "Record each run's cost and summarize it by project, caller, and day. Daily and monthly thresholds can send an alert or block new runs.",
  "home.domain.traces": "Traces & audit",
  "home.domain.tracesBody":
    "Inspect each run turn by turn, including tool calls. Secret access, administrative changes, and deletions are recorded in the audit log.",
  "home.guide.title": "Get started with Agent Studio",
  "home.guide.body": "Explore the guide to create your first project, connect tools, and start a conversation. No sign-in is needed to read it.",
  "home.product": "An AI agent platform.",

  // Vocabulary more than one page uses. A word here is one a reader meets on
  // several screens and should not have to re-learn.
  "catalog.clearSearch": "Clear search",
  "catalog.resetFilters": "Reset filters",
  "catalog.resultCount": "{count} of {total} results",
  "catalog.noResults": "No matches found. Try another search or reset your filters.",
  "projects.filter": "Search projects…",
  "projects.allTypes": "All project types",
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
    "Create prompt, agent, and image projects, test them in the console, and publish them for other systems. Agent tools also support document work and background audio processing.",
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
    "Learn to build agents, connect tools, and use your projects in conversations and applications.",
  "guide.contents": "Contents",

  "guide.start.title": "Start here",
  "guide.start.body":
    "Agent Studio is a platform for prompt, agent, and image projects. Read this guide without signing in. To start a conversation, sign in and choose an existing agent in Chats; to build your own, follow the steps below.",
  "guide.start.account": "1. Sign in and check your access",
  "guide.start.accountBody":
    "Open the address provided by your organization and use the sign-in method shown. Profile shows your tier, usage, and limits. New accounts normally start as guest; if project creation is unavailable, ask an administrator to change your tier in Members.",
  "guide.start.create": "2. Create a small first project",
  "guide.start.createBody":
    "In Projects, choose New project, enter an identifier and display name, and choose a type. For a first test, use llm for a prompt template or agent for a conversational assistant. Start with a short task whose expected answer you can judge before adding tools.",
  "guide.start.test": "3. Save, run, and inspect",
  "guide.start.testBody":
    "In Playground, select an available model and write the instructions. Save the version, enter a test input, and run it. Check the answer, warnings, usage, and tool activity. Run uses the saved version, so editing without saving does not test your new settings.",
  "guide.start.publish": "4. Publish and connect",
  "guide.start.publishBody":
    "Publish the tested version from Versions. For an HTTP caller, issue a project token in Integrations and follow API Reference. Publishing selects a default version; it does not create a separate application or freeze the configuration.",

  "guide.projects.title": "Choose the project type",
  "guide.projects.body":
    "A project groups versions, visibility, integrations, and usage under one identifier. A version holds the model, prompts, capabilities, and execution limits. Choose the type for the output and workflow you need.",
  "guide.projects.llm": "llm: a prompt template",
  "guide.projects.llmBody":
    "Use llm for summarization, classification, or rewriting in one model response. Put placeholders such as {{topic}} in the user prompt template and supply their values when running it. A system prompt sets the standing instructions. This type does not call tools or continue a tool loop.",
  "guide.projects.agent": "agent: conversation and tools",
  "guide.projects.agentBody":
    "Use agent when a task requires conversation, searches, tool calls, or delegation. Write its role, task boundaries, and expected output in the system prompt, then send the task as a message. The model chooses whether to use the tools made available to it; enabling a tool does not guarantee a call.",
  "guide.projects.image": "image: generation and editing",
  "guide.projects.imageBody":
    "Select an image generation model and describe the desired picture. Attach source images to edit them; without source images, the project generates a new picture. The system prompt supplies a recurring style. Test in Playground or Compare, and call the predict API for integration. Chats and chat completions do not run image projects.",

  "guide.versions.title": "Configure, compare, and publish versions",
  "guide.versions.body":
    "Treat a version as a named, editable configuration. For an experiment, choose + New version in Playground's version selector: it copies the current editor contents, and Save creates the new version. Use this path when callers already depend on the current configuration.",
  "guide.versions.model": "Model and fallback",
  "guide.versions.modelBody":
    "Select a model that supports the task: tool calling for agent projects, image input for reading pictures, or image generation for an image project. For llm and agent projects, configure a fallback model if needed. A fallback still needs the capabilities required by the request; it cannot make an incompatible model read an image.",
  "guide.versions.prompt": "Preview and save are different",
  "guide.versions.promptBody":
    "Use Prompt preview to inspect the prompt assembled from the current draft. It does not generate an answer, but a supplied request can call memory recall, contact MCP servers, and call embedding/rerank services for dynamic discovery. Save before using the run panel: its request executes the saved version. An agent receives user messages directly; llm template variables are not an agent input mechanism.",
  "guide.versions.limits": "Control run size",
  "guide.versions.limitsBody":
    "Set output length and agent turn limits to match the task. Presence penalty is an optional control for repeated tokens when the selected model supports it. Turn and output limits can leave a partial answer; a deployment deadline can stop the run with an error. Read completion reasons and warnings. Reasoning trace controls displayed reasoning, not whether the model reasons.",
  "guide.versions.compare": "Compare with the same input",
  "guide.versions.compareBody":
    "Save the candidate version, open Compare, choose two saved versions, and run the same input. Compare answer quality, warnings, duration, and usage. Both sides make real calls and count toward usage and concurrency limits; the comparison is not a free preview.",
  "guide.versions.publish": "Understand what changes after Publish",
  "guide.versions.publishBody":
    "In Versions, Publish points the project default at the selected version. Requests using published follow that pointer; requests naming a version keep using that name. Saving changes to a published version affects its next run immediately. To revert the default, publish a known good version; named-version callers must be updated separately.",

  "guide.capabilities.title": "Add skills, tools, and other agents",
  "guide.capabilities.body":
    "Administrators register capabilities on Skills, Tools, Agents, and Plugins. Project owners bind the available entries to a version, save, and test a task that needs them. Registration alone does not expose every capability to every run.",
  "guide.capabilities.skills": "Skills: reusable instructions",
  "guide.capabilities.skillsBody":
    "Have an administrator create the skill on Skills with a clear description, then bind it in the version editor. The model initially sees the name and description and can load the full instructions when needed. Use skills for repeatable procedures and domain guidance, and verify that the task actually causes the intended skill to be loaded.",
  "guide.capabilities.tools": "MCP: discover and select tools",
  "guide.capabilities.toolsBody":
    "Have an administrator register the server on Tools and check that discovery lists the expected tools. Bind the server to the version, select the tools to expose, and save the version. If calls fail, inspect the server status, required headers, and run warnings. A reachable server can still return no usable tools or require authorization.",
  "guide.capabilities.oauth": "MCP connection settings have different scopes",
  "guide.capabilities.oauthBody":
    "Tool selections and header overrides belong to the version and require Save. Administrators configure a shared OAuth app in Tools when needed; project owners use Connect to authorize their own account. All versions share the project’s authorization.",
  "guide.capabilities.agents": "Delegate to another agent",
  "guide.capabilities.agentsBody":
    "Delegate when a task benefits from a separate specialist; a routine workflow can use one Agent with skills. Bind a published local project or a registered external OpenAI-compatible or A2A agent. Give each delegate a precise description. Delegated activity is labelled by author, while usage remains part of the originating run accounting.",
  "guide.capabilities.plugins": "Import and synchronize plugins",
  "guide.capabilities.pluginsBody":
    "An administrator imports skills and MCP definitions from a configured repository or an uploaded checkout archive in Plugins. Use archive upload when the repository is unreachable. Inspect skipped/invalid entries and bind imported capabilities to your version. Imported skill content and MCP URLs/descriptions are maintained at the source and synchronized again; configure credentials separately in the console, because MCP headers are not imported. Sync does not delete orphaned entries automatically; review and remove them explicitly from its results.",
  "guide.capabilities.discovery": "Dynamic discovery and memory",
  "guide.capabilities.discoveryBody":
    "Dynamic discovery matches the system prompt and current request against capability names and descriptions, then adds relevant skills, MCP servers/tools, and external agents without changing saved bindings. A precise description is the routing signal: say when the capability should be used and what it returns. It needs a working capability catalog and embedding setup; ask an administrator if results are missing. Memory recall is separate and needs a bound MCP server offering recall.",
  "guide.capabilities.builtins": "Image, audio, URL, and file tools",
  "guide.capabilities.builtinsBody":
    "Enable image generation, audio processing, URL reading, or Slack history when needed and configure the corresponding services. With file storage configured, File reads, creates, and edits supported documents, while SaveFile creates text files. Audio uses a private source store and a separate worker. Document processing itself is built in and needs no MCP binding.",

  "guide.chat.title": "Conversations and attachments",
  "guide.chat.body":
    "Chats keeps conversations with agent projects. Use Playground for configuration tests and Chats for continuing work over multiple messages.",
  "guide.chat.version": "Choose the agent and version behavior",
  "guide.chat.versionBody":
    "Start a new chat and select an accessible agent project. Chats uses the published version when one exists, otherwise the latest saved version. llm and image projects are not chat choices. Publishing or editing a version can therefore change the behavior of later turns in an existing conversation.",
  "guide.chat.context": "Conversation history has limits",
  "guide.chat.contextBody":
    "The thread retains messages and tool activity, but the model receives a bounded history. A long conversation or large tool result can be shortened and produce a warning. Older images may remain visible in the thread without being sent in a later turn; attach the relevant image again when needed. Restate essential constraints and start a new conversation when the task changes substantially.",
  "guide.chat.attachments": "Images and documents",
  "guide.chat.attachmentsBody":
    "Attach PNG, JPEG, GIF, or WebP images to a model that supports image input. PDF, UTF-8 text, DOCX, XLSX, PPTX, HWP 5.x, HWPX, ODT/ODS/ODP, and RTF are read by the built-in document engine. Attach up to four documents of 10 MiB each. The conversation retains bounded extracted text; configured storage also keeps the originals. Check extraction and storage warnings after sending.",
  "guide.chat.createFiles": "Create a new document",
  "guide.chat.createFilesBody": "In an agent conversation, ask “Create a DOCX report from these notes” or “Make an XLSX budget table.” DOCX, PDF, PPTX, HWPX, and XLSX creation is built in. Plain text, Markdown, CSV, JSON, HTML, and SVG use SaveFile. File tools require configured storage. Download the result from the response and review its contents and layout. HTML previews run immediately in an isolated frame. Stop and Restart control execution; preview changes are not saved to the original.",
  "guide.chat.editFiles": "Edit an attachment and keep the original",
  "guide.chat.editFilesBody": "Attach the source, then ask “Inspect this document and change the heading to Quarterly results” or “Set Summary!B2 to 150.” DOCX, PPTX, and HWPX support selected text changes; XLSX supports cell changes; UTF-8 text supports unique substring replacement. The agent inspects targets and returns a new file. Follow-up requests can use the original or revised file.",
  "guide.chat.fileLimits": "Know the editing limits",
  "guide.chat.fileLimitsBody": "Reading a format does not guarantee editing it. PDF, HWP, ODT/ODS/ODP, and RTF have no source-preserving editor. Signed documents and macro workbooks are rejected for editing. Document text edits cannot add paragraphs or line breaks, and formulas are not calculated. Text changes may alter layout; review the downloaded result. Extracting text and rebuilding a document does not preserve its original formatting.",
  "guide.chat.stop": "Closing the page does not stop a chat run",
  "guide.chat.stopBody":
    "Use the chat's stop control to request cancellation. Navigating away or closing the browser tab only disconnects the view; reopen the conversation to read the saved result. Cancellation cannot undo actions a tool has already completed. A server interruption can still prevent an active run from finishing.",

  "guide.audio.title": "Audio processing and personal records",
  "guide.audio.body": "One Agent can handle collection, transcription, summaries, and requested records with reusable skills. A separate worker continues long jobs after the Agent response or browser page ends.",
  "guide.audio.setup": "Enable audio tools",
  "guide.audio.setupBody": "Ask an administrator to configure a private file store, a transcription service, and the audio worker. Enable Audio processing tools in your Agent version. The project owner sees the Audio processing tab when the published version enables it; before the first publication, the latest saved version is used.",
  "guide.audio.skills": "Keep one Agent and reusable skills",
  "guide.audio.skillsBody": "With the workspace plugin, bind audio-processing for the workflow, meeting-minutes for summaries, and personal-records for requested Document or Memory storage. Keep the system prompt short. Connect the recording source to this Agent and authenticate there. Separate download, transcription, and recording agents are not required.",
  "guide.audio.version": "Choose processing settings",
  "guide.audio.versionBody": "In Audio processing, select the transcription model, language, retention, and optional postprocessing Agent, then save project settings. The same Agent can do postprocessing. Follow published version uses the version published when each job is submitted and keeps that snapshot. An enabled setting that names a fixed version must be changed before that version can be deleted.",
  "guide.audio.run": "Start a job or schedule collection",
  "guide.audio.runBody": "Upload an audio file on the project page, or ask the Agent to collect a recording through its connected tool. For recurring collection, configure a schedule with a search range and maximum number of new recordings. Enable Run with my personal context as the owner. The worker and schedule ticker must be running; turning on audio tools alone does not schedule anything.",
  "guide.audio.results": "Read private Artifacts",
  "guide.audio.resultsBody": "Original audio, transcript JSON, summary Markdown, speaker dialogue, and structured results appear as the selected stages finish. Open them from the job or Artifacts. A submitted or duplicate request may still refer to an unfinished job: check the job status. Completed remains completed even when its last stage says Cleaning intermediate files. Review names, numbers, missing passages, and unknown speakers.",
  "guide.audio.records": "Save to Memory or Documents only when requested",
  "guide.audio.recordsBody": "The default result is private Artifacts. Specify which Artifact to save and whether you want a personal Document or Memory. The Agent reads that result and checks the destination service response. For unattended collection, leave the external destination empty. Saving a personal record does not delete the Artifact; the destination service has its own retention policy.",
  "guide.audio.retry": "Retry without starting completed stages again",
  "guide.audio.retryBody": "A waiting job resumes automatically. For failed jobs or jobs needing attention, fix the cause and use Retry. A manual retry starts a new 24-hour execution window while keeping completed stages, record IDs, and the original file expiry. Cancellation does not undo external records already created. A deleted or expired source may require a fresh import.",
  "guide.audio.reset": "Deleting files is not a processing reset",
  "guide.audio.resetBody": "Deleting Artifacts removes their files, but completed job history and duplicate-prevention records remain. To repeat one recording, explicitly ask the Agent to reprocess it. A full project reset is an administrator maintenance operation: pause scheduling, wait for active work to stop, and clear job history and duplicate-prevention records together. There is no reset-all button on this page.",

  "guide.api.title": "Call a project over HTTP",
  "guide.api.body":
    "API Reference is built into each project and fills in its address and published version. It contains request fields, response shapes, error codes, and curl or SDK examples. Use it alongside the steps here; no source checkout is needed.",
  "guide.api.token": "Prepare the project and credential",
  "guide.api.tokenBody":
    "Publish a tested version so execution examples appear. The owner or an administrator issues the token in Integrations; the owner's tier must allow API tokens. Replace $PROJECT_API_TOKEN in the example with that token and send Authorization: Bearer <token>. It is a project credential, not the LLM provider key, and it only runs that project.",
  "guide.api.version": "Choose a fixed version or published",
  "guide.api.versionBody":
    "Execution URLs use /api/projects/{name}/versions/{version}/ followed by the endpoint. The generated examples name the version currently published. Keep that name to target it explicitly, or use published to follow future Publish changes. Confirm the host is the Agent Studio address reachable from the calling system.",
  "guide.api.input": "Match the input to the project type",
  "guide.api.inputBody":
    "For llm predict, send variables matching the user prompt template, such as {\"variables\":{\"topic\":\"meeting notes\"},\"stream\":false}. For agent predict, send messages, such as {\"messages\":[{\"role\":\"user\",\"content\":\"Summarize these notes\"}],\"stream\":false}; variables are ignored. For image predict, send prompt and optionally source images for editing. Begin with a non-streaming request and inspect its response.",
  "guide.api.sdk": "OpenAI-compatible clients",
  "guide.api.sdkBody":
    "Use chat/completions for llm and agent projects and copy the Python or JavaScript example from API Reference. Set the SDK base URL to the version's URL shown there and the API key to the project token. The saved version selects the model and sampling parameters; sending model, temperature, or max_tokens does not override them. Image projects use predict instead.",
  "guide.api.stream": "Streaming and conversation history",
  "guide.api.streamBody":
    "For text predict or chat/completions, stream:true returns SSE; agent also provides an endpoint for streaming text and tool activity. Keep the connection open and handle warning, error, and completion events, because HTTP 200 alone does not prove the run succeeded. HTTP callers send their own message history. X-Conversation-Id can preserve downstream MCP/A2A conversation identity, but does not load past messages for you.",
  "guide.api.result": "Check the result and protect the token",
  "guide.api.resultBody":
    "Inspect usage, warnings, and the completion reason as well as the answer. turn-limit or output-limit on predict means a partial result; chat completions reports length for limit stops. Download file results before their links expire. Keep tokens in the calling server's secret storage. Regenerating or revoking a project token invalidates the old token immediately, so update every caller.",

  "guide.integrations.title": "Bots, protocols, and automation",
  "guide.integrations.body":
    "Project owners and administrators configure integrations. Publish a version first and verify one real call after setup. External platforms need their own credentials and network connectivity; they are optional in an offline installation.",
  "guide.integrations.slack": "Slack",
  "guide.integrations.slackBody":
    "For an agent project, copy the app manifest from Integrations, create and install the dedicated Slack app, and save its bot token and signing secret. Enable events, check the displayed events URL, and run Test connection. Invite the bot to the target channel and mention it. A successful credential test does not prove Slack can deliver events to the application.",
  "guide.integrations.messengers": "Telegram and Teams",
  "guide.integrations.messengersBody":
    "In an agent project's Integrations, save and enable the Telegram bot token; enabling registers its webhook. Use Register webhook again after an application URL change. For Teams, enable the Azure Bot's Teams channel, save its application ID and client secret (plus tenant ID for a single-tenant app), and set its messaging endpoint to the displayed URL. Test in a direct conversation before trying group mentions.",
  "guide.integrations.a2a": "A2A and AG-UI",
  "guide.integrations.a2aBody":
    "A2A exposes published public projects to compatible agents; administrators configure shared or named client keys in Settings, and callers use X-A2A-Key. Check the Agent Card URL in Integrations. AG-UI runs a published project inside your own interface using the project token. Copy its client example from Integrations and let your application manage the message thread and render protocol events.",
  "guide.integrations.webhook": "Receive a webhook",
  "guide.integrations.webhookBody":
    "In project Settings, configure and enable the webhook, copy its URL, and send the secret in X-Trigger-Secret. Choose message payload mode for an agent message or variables mode for template fields. HTTP 202 acknowledges delivery, not a finished answer; inspect the trigger's run history for success, output, skips, or failures. Concurrent deliveries are skipped unless allowed.",
  "guide.integrations.schedule": "Schedule a recurring task",
  "guide.integrations.scheduleBody":
    "In project Settings, add a schedule with a five-field cron expression, an IANA time zone such as Asia/Seoul, and the message or variables to run. Select any delivery destinations and enable it. Schedules use the published version and require the deployment's external ticker. Check both run status and delivery results: a generated answer can succeed even when sending it to a bot fails.",

  "guide.records.title": "Results, usage, and limits",
  "guide.records.artifacts": "Find originals and generated files",
  "guide.records.artifactsBody":
    "Personal Artifacts includes files attributed to your email, including personal-context automation. Project Artifacts also includes outputs without a personal owner. Private audio originals and results can only be read or deleted by their owner. Reopen an ordinary artifact to refresh an expired signed link; this does not restore an expired or deleted file. Download files you need beyond retention. Deleting a chat does not delete its artifacts.",
  "guide.records.usage": "Understand usage and attribution",
  "guide.records.usageBody":
    "Use project Usage to inspect the selected period and model/provider breakdown; owners and administrators can inspect caller details. Profile shows personal usage. Project-token calls are accounted to the project rather than the owner's personal budget. Prices come from provider-reported cost or catalog pricing; a zero estimate is not proof that the provider charged nothing.",
  "guide.records.budgets": "Alerts, blocks, and concurrent runs",
  "guide.records.budgetsBody":
    "Project Settings separates daily/monthly alert and block thresholds. Alerts notify when a destination is configured; blocks refuse new runs until the UTC day or month resets, even without notifications. Personal tier limits and caller concurrency limits also apply where relevant. Costs can arrive after a run finishes, so thresholds are not a prepaid balance that guarantees no overspend.",
  "guide.records.traces": "Investigate a run in Traces",
  "guide.records.tracesBody":
    "Owners and administrators can open project Traces to inspect preparation, model calls, tools, delegates, durations, usage, and warnings. Traces is a diagnostic record, not a complete archive of prompts and tool output. Agent runs are traced, while llm and image tracing can be sampled. A missing trace can also mean the request was refused before execution started.",

  "guide.security.title": "Access and sensitive data",
  "guide.security.body":
    "Choose access rules before sharing a project or connecting data sources. The console, model provider, tools, and file store are separate places where information may be processed.",
  "guide.security.visibility": "Public, private, and editing rights",
  "guide.security.visibilityBody":
    "A public project is accessible to signed-in users of this installation; it is not anonymous access to every API. Private projects limit access to the owner, invited emails, and administrators. Invitations allow viewing and running, not editing. Owners and administrators manage versions, settings, integrations, traces, and project-wide artifacts. Machine credentials have their own access rules.",
  "guide.security.credentials": "Secrets and shared links",
  "guide.security.credentialsBody":
    "Do not put API keys in prompts, skill text, browser code, screenshots, or support messages. Use the dedicated credential fields. A masked value is a display placeholder, not a working key to copy. Treat signed artifact links as credentials: someone holding a link may read the file until it expires. If a token leaks, revoke or regenerate it and update its callers.",
  "guide.security.pii": "PII filtering is a limited protection",
  "guide.security.piiBody":
    "A version's PII filtering replaces recognized patterns before sending model text and restores them in user-facing output. It is not complete anonymization: restored information can appear in tool arguments, saved answers, reasoning, and files. Discovery embedding/rerank queries and memory recall queries are outside this filter. Use approved model and tool services for sensitive work.",
  "guide.security.network": "Private services need explicit network access",
  "guide.security.networkBody":
    "Ask the deployment operator to allow the specific internal DNS suffix when a legitimate internal service is blocked. MCP servers use MCP_INTERNAL_HOST_SUFFIXES; URL reading uses URL_FETCH_INTERNAL_HOST_SUFFIXES. They are different settings. A declared host must still be reachable and authorized; an allow entry does not supply credentials or open a firewall.",

  "guide.admin.title": "Administrator settings",
  "guide.admin.body":
    "Members, Settings, Models, and Audit serve different purposes. Changes here can affect multiple projects, so verify the affected path after saving. Registry pages are available to members and administrators; creating and maintaining their entries is an administrator task.",
  "guide.admin.members": "Manage member tiers",
  "guide.admin.membersBody":
    "In Members, find the user and change the tier when they need project creation or API-token access. Profile is where the user checks their resulting limits. Administrators listed in ADMIN_EMAILS have a fixed admin tier; removing an email from the list does not automatically demote its stored tier. Members is not an account-creation or password-reset screen.",
  "guide.admin.settings": "Settings overrides and deployment values",
  "guide.admin.settingsBody":
    "Settings manages the public base URL, artifact access mode, access lists, LLM channels, plugin repository, and A2A credentials. Saved values override deployment environment values, which override defaults. Saving an empty field removes that override and falls back to the environment; for a secret, this is not a guarantee that the service becomes disabled. Database, encryption, sign-in provider, storage connection, retention, and internal-host settings remain deployment configuration.",
  "guide.admin.models": "Connect and verify models",
  "guide.admin.modelsBody":
    "Configure the default LLM or provider channel URL and credentials in Settings, including the API base path required by the endpoint. When changing a URL, enter its matching key too; the old masked key cannot be reused for a new destination. In Models, inspect capabilities and availability, run Test, then run a short project. A catalog entry describes a model; it does not install or serve it.",
  "guide.admin.offline": "Catalog and retrieval in an offline deployment",
  "guide.admin.offlineBody":
    "Upload a model catalog document in Models when remote synchronization is unavailable. Use Self-hosted declarations for models actually served by your internal endpoint. Capability discovery requires CATALOG_ENABLED=true in the deployment and a working embedding setup; rerank is optional. Changing embedding requires rebuilding the index. Unknown model IDs follow the deployment's allow/refuse policy and may lack cost estimates.",
  "guide.admin.artifacts": "Choose how users reach artifacts",
  "guide.admin.artifactsBody":
    "Set PUBLIC_BASE_URL to the application's user-facing address. In Settings, proxied artifact access sends bytes through the application and suits a store that browsers cannot reach. authenticated returns an expiring storage URL, so browsers need direct storage access. public requires public-read storage policy and lets anyone with the URL read it. Validate by generating, reopening, and downloading a file from a user's network.",
  "guide.admin.audit": "Review administrative changes",
  "guide.admin.auditBody":
    "Use Audit to inspect the selected date range, actor, action, target, and details. Credential reveal operations are recorded as well. Use these records to identify who changed configuration or accessed an issued secret, and use project Traces for execution diagnostics. Retention limits apply to both kinds of record.",

  "guide.install.title": "Install without source code",
  "guide.install.body":
    "This section is for the deployment operator. An ordinary console user only needs the application address and an account. Obtain the release image and the deployment-specific launch, secret, ingress, and backup settings from the package provider; source files and development commands are not prerequisites for using the image.",
  "guide.install.prepare": "1. Prepare the services and image",
  "guide.install.prepareBody":
    "Use a versioned release image, PostgreSQL with pgvector (the deployment baseline is PostgreSQL 18), and a reachable OpenAI-compatible LLM endpoint. Mirror the image into an internal registry before entering an isolated network. Add an S3-compatible object store if files must persist. The deployment owns service addresses, credentials, volumes, TLS, and routing.",
  "guide.install.environment": "2. Supply required configuration",
  "guide.install.environmentBody":
    "Supply DATABASE_URL, LLM_BASE_URL, LLM_API_KEY, and AES_ENCRYPTION_KEY through the deployment's secret/configuration mechanism. AES_ENCRYPTION_KEY must encode 32 bytes in base64 and remain stable across restarts. Set STAGE explicitly (prod for production); alpha/prod also requires ADMIN_EMAILS and a sign-in method. Set BETTER_AUTH_SECRET to a stable session secret and BETTER_AUTH_URL and PUBLIC_BASE_URL to the user-facing application address in the deployment environment before configuring callbacks.",
  "guide.install.signin": "3. Configure sign-in",
  "guide.install.signinBody":
    "For offline operation, configure internal Keycloak, standard OIDC, or password sign-in. Keycloak needs KEYCLOAK_ISSUER (the realm URL), KEYCLOAK_CLIENT_ID, and KEYCLOAK_CLIENT_SECRET; register /api/auth/callback/keycloak with the client. Standard OIDC uses OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET with /api/auth/callback/oidc. Google can be enabled alongside either provider using GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Password bootstrap uses AUTH_PASSWORD=true, BOOTSTRAP_ADMIN_EMAIL, and BOOTSTRAP_ADMIN_PASSWORD; include that email in ADMIN_EMAILS. Changing the bootstrap password does not reset an existing password account.",
  "guide.install.storage": "4. Connect persistent file storage",
  "guide.install.storageBody":
    "For persistent files, create a bucket and set S3_BUCKET_NAME. For a non-AWS store, also set S3_ENDPOINT, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY. AWS S3 can use the deployment's AWS credential or role configuration. Grant the storage identity read, write, and delete access to artifacts/* and source-files/* in that bucket, plus multipart upload permissions for private files. Keep non-AWS storage keys in the S3 fields rather than AWS_* variables used by other providers. Select the artifact access mode in Settings and verify downloads from the user's network.",
  "guide.install.verify": "5. Start and verify the full path",
  "guide.install.verifyBody":
    "The application validates configuration and applies database migrations on startup. Check health and readiness, sign in as the administrator, test a model, and create and run a small project. If storage is configured, reopen a generated file. Test internal MCP and any enabled integrations individually; a reachable console alone does not validate them.",

  "guide.operations.title": "Operate, retain, and upgrade",
  "guide.operations.body":
    "The deployment operator owns monitoring, scheduled calls, backups, and rollouts. Configure these alongside the application rather than assuming that saving a console setting starts background infrastructure.",
  "guide.operations.health": "Health is not a successful model run",
  "guide.operations.healthBody":
    "GET /api/health checks process liveness. GET /api/ready checks database and default LLM reachability and returns 503 when unavailable or draining. LLM reachability only requires an HTTP response, so even a 401 or 404 from its models endpoint can pass. Verify credentials and model support with Models Test and a real project run.",
  "guide.operations.ticker": "Run the external ticker",
  "guide.operations.tickerBody":
    "Set SCHEDULE_SCAN_TOKEN and configure an external scheduler to POST /api/triggers/scan with X-Scan-Token at least once per minute. Setting the token alone starts nothing. This call drives schedules and expired database-row cleanup. A missing deployment token returns 503; an absent or incorrect request token returns 401. Check scan results and trigger histories after enabling it; long outages do not replay every missed occurrence.",
  "guide.operations.catalog": "Refresh the capability index",
  "guide.operations.catalogBody":
    "If capability discovery is enabled, configure a separate hourly POST /api/catalog/reindex with the same X-Scan-Token credential. The schedule scan does not perform this reindex. A successful response starts background indexing; inspect the server log for indexed, removed, or undiscovered entries, then test a question that should discover a newly registered capability.",
  "guide.operations.retention": "Database retention and file lifecycle",
  "guide.operations.retentionBody":
    "Database retention settings control trace, usage, chat, artifact, trigger, A2A, and audit rows. Keep ordinary artifact retention at least as long as chat retention and configure matching object lifecycle rules. Private audio files use their own day or calendar-month expiry, inherited by derived outputs and enforced by the audio worker. Do not apply blanket object expiration to source-files/ in the shared Artifacts bucket: deletion barriers must remain. Deleting or expiring audio Artifacts does not clear job history or duplicate-prevention records.",
  "guide.operations.backup": "Back up data and recovery keys",
  "guide.operations.backupBody":
    "Back up PostgreSQL, stored objects, deployment configuration, and the encryption/session secrets under restricted access. Restore them together in a separate environment and verify sign-in, credential decryption, project runs, and file access. Losing or arbitrarily replacing AES_ENCRYPTION_KEY makes stored credentials unreadable. An application image is not a data backup.",
  "guide.operations.upgrade": "Upgrade with a recovery plan",
  "guide.operations.upgradeBody":
    "Record the current image version and verify backups before changing the image. Allow active runs time to drain during shutdown, then check startup migration logs and repeat the basic sign-in/run/file checks. Reverting the image tag does not downgrade the database schema. Confirm schema compatibility and the deployment's restore procedure before relying on rollback.",

  "guide.trouble.title": "Troubleshooting",
  "guide.trouble.body":
    "Start with the failing surface, the exact error, and whether the run began. Change one relevant setting at a time, then repeat the smallest request that demonstrates the problem.",
  "guide.trouble.access": "Sign-in fails or a control is unavailable",
  "guide.trouble.accessBody":
    "Check the configured sign-in method, allowed email domain, and account with the administrator. A missing create/edit control can be a tier or ownership restriction. For API 401, check the token and project name; for 403, check current owner tier and permissions. A private or inaccessible project can return 404, so do not assume the URL alone is wrong.",
  "guide.trouble.model": "A model is missing or a call fails",
  "guide.trouble.modelBody":
    "In Models, check hidden and availability states and run Test. Ask the administrator to confirm the provider URL, base path, credentials, and model ID, then save the intended model in the project version. For 400, compare the request fields and image/tool requirements with API Reference. For provider errors such as 502, inspect the reported upstream error; retrying unchanged does not fix a wrong model or URL.",
  "guide.trouble.limits": "429, timeout, or an incomplete answer",
  "guide.trouble.limitsBody":
    "For 429, inspect concurrent runs, project daily/monthly blocks, and personal tier usage; follow Retry-After on API responses. For a timeout or stream error, inspect the provider, slow tools, and deployment deadline. For turn-limit, output-limit, or length, narrow the task or adjust the saved version's appropriate limit. Avoid blind retries when a tool may already have changed external data.",
  "guide.trouble.tools": "A tool or memory is not used",
  "guide.trouble.toolsBody":
    "Confirm the capability is bound to the saved version and visible in Prompt preview. Check tool selection, discovery, OAuth connection, and run warnings. Ask a question that actually requires the tool. For internal-host blocks, involve the deployment operator; for memory, verify a bound server offers recall. A document reader must be explicitly bound, not merely discoverable.",
  "guide.trouble.automation": "A bot or schedule is silent",
  "guide.trouble.automationBody":
    "Check the published version, integration enabled state, credentials, and callback reachability. Test a direct bot message or explicit mention. For schedules, also check enabled state, cron time zone, and the external ticker. Inspect skipped/failed runs and delivery results in project Settings; a successful model run with a failed destination is a delivery problem.",
  "guide.trouble.files": "Attachments or downloads fail",
  "guide.trouble.filesBody":
    "Check the file type and upload limits first. An image needs an image-capable model; Office reading uses the built-in engine. Password-protected files, scans needing OCR, and unsupported edits require another workflow. If File is unavailable or the original was not kept, ask the operator to check storage configuration. For download failures, reopen Artifacts and check storage warnings, access mode, public base URL, connectivity, and retention.",
  "guide.trouble.support": "What to send for support",
  "guide.trouble.supportBody":
    "Record the application version, project and saved version names, surface, time and time zone, error/status code, trace ID if available, and a minimal input that reproduces the issue. Include what you expected and whether the failure occurs in Playground too. Remove tokens, cookies, private file links, and sensitive content. Installation-specific startup and recovery problems belong with the deployment operator or package provider.",

  // Chats: the sidebar, the thread, the composer and the parts a turn is drawn
  // from.
  "chat.more": "Show older entries",
  "chat.answerReady": "Answer complete",
  "chat.new": "New chat",
  "chat.list": "Chats",
  "chat.kind": "Chat",
  "chat.history": "Chats & Workspaces",
  "chat.none": "No chats yet.",
  "chat.delete": "Delete chat",
  "chat.notFound": "Chat not found.",
  "chat.reloadFailed": "This reply is saved, but the conversation could not be reloaded.",
  "chat.jumpToLatest": "Jump to the latest message",
  "chat.approvalTitle": "Approval required",
  "chat.approvalHint": "Review the agent, tool and full arguments before allowing the action.",
  "chat.approvalInterrupted": "Execution stopped before its outcome was saved. Review the chat and tool outputs before starting another run.",
  "chat.approve": "Approve",
  "chat.reject": "Reject",
  "chat.discardApproval": "Discard pending run",
  "chat.discardApprovalHint": "Discarding keeps the visible chat record and removes this unfinished run from future model context.",
  "version.runtimePolicy": "Runtime policy",
  "version.maxInputChars": "Maximum input text characters",
  "version.blockedTools": "Blocked tool names",
  "version.approvalTools": "Tool names requiring approval",
  "version.approvalToolsHint": "Use names from Prompt preview. Approvals require Chat. Use delegate tools instead of handoffs for approved delegation.",
  "chat.send": "Send",
  "chat.stop": "Stop",
  "chat.placeholder": "Send a message…",
  "chat.firstPlaceholder": "Send your first message…",
  "chat.pickProject": "Pick an agent project and send your first message.",
  "chat.welcomeTitle": "What would you like to work on?",
  "chat.welcomeHint": "Your conversation stays with the selected project. Start a new chat to switch projects.",
  "chat.messageLabel": "Message",
  "chat.inputHint": "Enter to send · Shift + Enter for a new line",
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
  "projects.descriptionHint":
    "Shown to parent agents when this published project is bound as a local subagent, and published in its A2A Agent Card. State which requests it should receive and what result it returns.",
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
  "version.presencePenalty": "Presence penalty",
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
    "Searches capability names and descriptions with this version’s system prompt and the incoming request, then offers the matching skills, MCP servers/tools, and external agents on top of the bindings above. The opening 500 characters of each description are indexed, so say what request the capability handles before implementation details. Bindings are always offered in full. An MCP server that needs its own sign-in is offered only after this project connects it.",

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
    "Authorize this project’s user account with the OAuth client configured by the operator. Saved immediately, not with the version.",
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
    "Used for memory recall and capability matching. Building the preview sends it to configured MCP and embedding/rerank services. Use a real request to inspect the context and capabilities that run would receive; leave it empty for the common starting point.",
  "preview.requestPlaceholder": "e.g. what is the latest EKS version?",
  "preview.hideTools": "Hide tools",
  "preview.chars": "{count} chars",
  "preview.tools": "· {count} tools",
  "preview.stale": "· stale",
  "preview.discovered": "Found for this preview, on top of the bindings: {names}",
  "preview.noPrompt":
    "This version sends no prompt of its own; the conversation supplies everything.",
  "preview.toolsOffered": "Tools offered ({count})",
  "preview.blurb":
    "Builds the system prompt the way a run does — recalled context, skill table, connected MCP servers and their tool names, transfer instructions — by contacting the configured services on demand.",

  // A project's OAuth authorization for one MCP server.
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
    "This provider requires a manually registered OAuth app. An administrator must save its client ID and secret in the MCP server’s Tools OAuth settings before a project can connect.",
  "mcpConn.authorizedBy": "Authorized by {who} on {when}",
  "mcpConn.saveCredentials": "Save credentials",
  "mcpConn.disconnect": "Disconnect",
  "mcpOAuth.automatic": "Projects can connect without a manually registered OAuth app. A reachable client metadata document is used first, then dynamic registration when available.",
  "mcpOAuth.manual": "Manual OAuth app settings",
  "mcpOAuth.sharedHint": "Shared by projects using this MCP. Clear Client ID to remove the manual app; automatic registration is used only when the provider supports it.",
  "mcpOAuth.secretHint": "Leave blank to keep the stored secret. Changing Client ID requires a new secret if the provider uses one.",
  "mcpOAuth.redirectHint": "Filled from the deployment’s public URL. Register this exact callback with the OAuth provider.",
  "mcpOAuth.save": "Save OAuth client",

  // Wording the four registry catalogs (skills, tools, agents, plugins) share.
  // Each page had its own copy of these; a reader meets them on all four.
  "registry.nameLabel": "Name",
  "registry.nameHint": "Lowercase letters, digits, and hyphens only.",
  "registry.description": "Description",
  "registry.discoveryPromptBadge": "Discovery + model prompt",
  "registry.content": "Content (markdown)",
  "registry.contentHeading": "Content",
  "registry.operatorOnlyBadge": "Operator only",
  "registry.operatorNotes":
    "Operator notes for the console. Not sent to the model — only the description is.",
  "registry.register": "Register",
  "registry.create": "Create",
  "registry.url": "URL",
  "registry.headersEmpty": "No headers. Add one if the endpoint needs auth.",

  // Skills.
  "skills.lede":
    "Markdown behavior instructions loaded on demand by the agent engine. Synced skills arrive through Plugins.",
  "skills.descriptionRole":
    "A skill is found and chosen from its name and description before its content is loaded. Dynamic discovery indexes the opening 500 characters, and the full description appears in the model’s Available Skills table. Write when to use the skill and what outcome it enables. Content becomes the execution instructions after selection.",
  "skills.descriptionHint":
    "Used for dynamic discovery and shown to the model before content is loaded. Lead with when to use this skill and the outcome it enables.",
  "skills.descriptionDetailHint":
    "This is the routing text available before the model chooses a skill. Content below is unavailable until the model loads this skill.",
  "skills.descriptionPlaceholder": "Use when reviewing code changes for defects, regressions, and missing tests",
  "skills.contentHint":
    "Loaded after the model selects this skill. Put the workflow, rules, constraints, and references needed to perform it here.",
  "skills.contentBadge": "Loaded after selection",
  "skills.new": "New skill",
  "skills.filter": "Filter skills…",
  "skills.empty": "No skills yet. Sync a plugins repo, or create one here.",
  "skills.namePlaceholder": "my-skill",
  "skills.contentPlaceholder": "# Instructions…",
  "skills.noContent": "No content.",

  // External agents.
  "agents.lede":
    "External OpenAI-compatible and A2A endpoints a project version can bind as remote subagents.",
  "agents.descriptionRole":
    "External agent descriptions drive dynamic discovery and are shown in the model’s Available Agents table for transfer decisions. The opening 500 characters are indexed. Workspace project descriptions are not dynamically discovered, but they appear when bound as local agents and in published A2A Agent Cards.",
  "agents.descriptionHint":
    "Used for dynamic discovery and transfer selection. State which requests this agent should handle and what result it returns.",
  "agents.descriptionPlaceholder": "Investigates Kubernetes incidents and returns evidence-backed remediation steps",
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
  "tools.descriptionRole":
    "The server name and opening 500 characters of its description are indexed for dynamic discovery and shown in the model’s Connected MCP Servers table. Each tool’s own description is also indexed and sent with its input schema, so it usually decides which action matches. Content is operator-only notes.",
  "tools.descriptionHint":
    "Used for server-level discovery and shown to the model. Describe the tasks this server enables; selection of a specific action also uses each tool’s own description.",
  "tools.descriptionDetailHint":
    "This is the server-level routing text. After the server is selected, each tool’s own description and input schema guide the specific action.",
  "tools.descriptionOwnedHint":
    "Owned by the plugin repository. Edit it there: this description still drives server discovery and appears in the model prompt.",
  "tools.toolDescriptionsHint":
    "Each tool description is indexed for dynamic discovery and sent to the model with that tool’s input schema.",
  "tools.noDescription":
    "No server description. Dynamic discovery can only match the server name or tool descriptions from a successful probe.",
  "tools.connectionAndDescriptions": "Connection and tool descriptions",
  "tools.connectionDescriptionHint":
    "Test the connection to inspect the model-facing descriptions published by this server for each tool.",
  "tools.operatorNotesHeading": "Operator notes",
  "tools.showOperatorNotes": "Show all operator notes",
  "tools.hideOperatorNotes": "Collapse operator notes",
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
  "plugins.descriptionTitle": "Component descriptions drive runtime use",
  "plugins.descriptionRole":
    "A plugin description helps people browse and filter packages; the runtime does not search plugins. Dynamic discovery searches the descriptions of the skills, MCP servers, and MCP tools inside the plugin. Make each component description say when it should be used.",
  "plugins.filter": "Filter plugins…",
  "plugins.empty": "No plugins yet. Add the repository and token in Settings, then sync.",
  "plugins.noSkills": "This plugin declares no skills.",
  "plugins.noServers": "This plugin declares no MCP servers.",
  "plugins.uploadArchive": "Upload archive",
  "plugins.uploadArchiveHint":
    "A .tar.gz of the plugins repository (git archive or tar of a checkout) — for a deployment that cannot reach GitHub.",
  "plugins.archiveSource": "Archive: {name}",
  "plugins.uploadFailed": "Upload failed",

  "capabilities.descriptionTitle": "Description controls discovery",

  // Artifacts.
  "artifacts.preview.title": "HTML preview",
  "artifacts.preview.note": "Web requests are restricted, but this is not a fully offline sandbox. Changes are not saved.",
  "artifacts.preview.controls": "Preview controls",
  "artifacts.preview.stop": "Stop",
  "artifacts.preview.restart": "Restart",
  "artifacts.preview.stopped": "Preview stopped. Restart to load the original file again.",
  "artifacts.preview.blocked": "The preview blocked a browser operation or resource. Use self-contained HTML; restart if the page stopped responding.",
  "artifacts.preview.error": "The file reported a script error. Stop the preview or ask for a corrected file.",
  "artifacts.preview.noScript": "Enable JavaScript in your browser to run this preview.",

  "artifacts.lede":
    "Stored attachment originals and files created or edited by your runs. Files from Slack, triggers, and A2A are also available to authorized readers on the project’s artifact page.",
  "artifacts.empty": "Nothing kept yet. Stored attachment originals and generated files appear here.",
  "artifacts.filter": "Filter…",
  "artifacts.delete": "Delete",
  "artifacts.all": "All",
  "artifacts.images": "Images",
  "artifacts.preview": "Preview",
  "artifacts.documents": "Documents",
  "artifacts.audio": "Audio",
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
  "artifacts.kindAudio": "audio file",

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
  "audit.time": "Time",
  "audit.action": "Action",
  "audit.actor": "Actor",
  "audit.target": "Target",
  "audit.detail": "Detail",
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
  "models.generateTestImage": "Generate test image",
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
