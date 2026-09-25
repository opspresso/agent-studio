import { describe, expect, it } from "vitest";
import { convertLegacyAgentItem, type ReencryptSecret } from "@/infrastructure/db/agentDataMigration";

const reencrypt: ReencryptSecret = (value, previous, next) => JSON.stringify({ value, previous, next });
const row = (pk: string, sk: string, extra: Record<string, unknown>): Record<string, unknown> => ({ PK: pk, SK: sk, ...extra });

describe("restored Agent data conversion", () => {
  it("renames Agent identity and reencrypts scoped credentials", () => {
    const original = row("PROJECT#writer", "META", {
      GSI1PK: "TYPE#PROJECT", GSI1SK: "writer", entityType: "PROJECT", name: "writer",
      configuration: { projectName: "writer", systemPrompt: "Keep the user's projectName literal.",
        mcpList: [{ name: "files", headers: { Authorization: "old-header", Removed: null } }] },
      slack: { botToken: "old-bot", signingSecret: "old-signing" },
      telegram: { botToken: "old-telegram", webhookSecret: "old-webhook" },
      teams: { appPassword: "old-teams" },
    });
    const { item, secrets } = convertLegacyAgentItem(original, reencrypt);
    expect(secrets).toBe(6);
    expect(item).toMatchObject({ PK: "AGENT#writer", SK: "META", GSI1PK: "TYPE#AGENT", entityType: "AGENT",
      configuration: { agentName: "writer", systemPrompt: "Keep the user's projectName literal." } });
    expect((original.configuration as Record<string, unknown>).projectName).toBe("writer");
    const config = item.configuration as { mcpList: Array<{ headers: Record<string, string | null> }> };
    expect(config.mcpList[0]!.headers.Removed).toBeNull();
    expect(JSON.parse(config.mcpList[0]!.headers.Authorization!)).toEqual({
      value: "old-header",
      previous: JSON.stringify([JSON.stringify(["project", "writer", "agent", "mcp", "files"]), "Authorization"]),
      next: JSON.stringify([JSON.stringify(["agent", "writer", "configuration", "mcp", "files"]), "Authorization"]),
    });
  });

  it("converts token, MCP grant, Trigger, source reference and saved binding contexts", () => {
    const token = convertLegacyAgentItem(row("PROJECT#writer", "APITOKEN", { entityType: "APITOKEN", token: "old-token" }), reencrypt);
    expect(token.item.PK).toBe("AGENT#writer");
    expect(JSON.parse(token.item.token as string)).toMatchObject({
      previous: JSON.stringify(["project", "writer", "api-token"]),
      next: JSON.stringify(["agent", "writer", "api-token"]),
    });
    const connection = convertLegacyAgentItem(row("PROJECT#writer", "MCPCONN#files", {
      entityType: "MCPCONNECTION", projectName: "writer", serverName: "files",
      clientSecret: "old-client", accessToken: "old-access", refreshToken: "old-refresh",
    }), reencrypt);
    expect(connection.secrets).toBe(3);
    expect(connection.item.agentName).toBe("writer");
    expect(JSON.parse(connection.item.accessToken as string)).toMatchObject({
      previous: JSON.stringify(["project", "writer", "mcp", "files", "access-token"]),
      next: JSON.stringify(["agent", "writer", "mcp", "files", "access-token"]),
    });
    const trigger = convertLegacyAgentItem(row("PROJECT#writer", "TRIGGER#hook", {
      entityType: "Trigger", projectName: "writer", triggerId: "hook", secret: "old-trigger",
    }), reencrypt);
    expect(trigger.secrets).toBe(1);
    expect(trigger.item.agentName).toBe("writer");
    const reference = convertLegacyAgentItem(row("SOURCEREFERENCE#ref", "META", {
      entityType: "SourceReference", reference: { id: "ref", projectName: "writer", encryptedUrl: "old-url" },
    }), reencrypt);
    expect(reference.secrets).toBe(1);
    expect(reference.item.reference).toMatchObject({ agentName: "writer" });
    const version = convertLegacyAgentItem(row("PROJECT#writer", "VERSION#one", {
      entityType: "VERSION", projectName: "writer", versionName: "one",
      mcpList: [{ name: "files", headers: { X: "old-version" } }],
    }), reencrypt);
    expect(version.secrets).toBe(1);
    expect(JSON.parse((version.item.mcpList as Array<{ headers: { X: string } }>)[0]!.headers.X)).toEqual({
      value: "old-version",
      previous: JSON.stringify([JSON.stringify(["project", "writer", "version", "one", "mcp", "files"]), "X"]),
      next: JSON.stringify([JSON.stringify(["agent", "writer", "version", "one", "mcp", "files"]), "X"]),
    });
  });

  it("converts typed references and indexes while leaving user payloads intact", () => {
    const trace = convertLegacyAgentItem(row("TRACE#t", "META", {
      entityType: "TRACE", projectName: "writer", projectType: "agent", GSI1PK: "TRACEPROJECT#writer",
      actor: { kind: "project-token", id: "owner@example.test" },
      spans: [{ metadata: { projectName: "user supplied" } }],
    }), reencrypt).item;
    expect(trace).toMatchObject({ agentName: "writer", agentType: "agent", GSI1PK: "TRACEAGENT#writer",
      actor: { kind: "agent-token" }, spans: [{ metadata: { projectName: "user supplied" } }] });
    const artifact = convertLegacyAgentItem(row("ARTIFACT#a", "META", {
      entityType: "ARTIFACT", projectName: "writer", GSI1PK: "ARTIFACTPROJECT#writer",
    }), reencrypt).item;
    expect(artifact).toMatchObject({ agentName: "writer", GSI1PK: "ARTIFACTAGENT#writer" });
    const usage = convertLegacyAgentItem(row("USAGE#writer", "ACTOR#2026-09-25#project-token:owner@example.test", {
      entityType: "Usage", projectName: "writer", actor: "project-token:owner@example.test",
    }), reencrypt).item;
    expect(usage).toMatchObject({ SK: "ACTOR#2026-09-25#agent-token:owner@example.test",
      agentName: "writer", actor: "agent-token:owner@example.test" });
    const audit = convertLegacyAgentItem(row("AUDIT#2026-09-25", "entry", {
      entityType: "AuditEvent", action: "project.delete", target: "project:writer", detail: "An old projectName appeared in user text",
    }), reencrypt).item;
    expect(audit).toMatchObject({ action: "agent.delete", target: "agent:writer",
      detail: "An old projectName appeared in user text" });
    const chat = convertLegacyAgentItem(row("CHAT#one", "META", {
      entityType: "Chat", projectName: "writer", linkedProjects: { writer: "workspace-1" },
    }), reencrypt).item;
    expect(chat).toMatchObject({ agentName: "writer", linkedAgents: { writer: "workspace-1" } });
    const message = convertLegacyAgentItem(row("CHAT#one", "MSG#000001", {
      entityType: "ChatMessage", message: { projectName: "user supplied" },
    }), reencrypt).item;
    expect(message.message).toEqual({ projectName: "user supplied" });
  });

  it("converts nested Workspace and audio references without rewriting event payloads", () => {
    const workspace = convertLegacyAgentItem(row("WORKSPACE#one", "META", {
      entityType: "WORKSPACE", value: { projectName: "writer", title: "projectName in a title" },
    }), reencrypt).item;
    expect(workspace.value).toEqual({ agentName: "writer", title: "projectName in a title" });
    const event = convertLegacyAgentItem(row("WORKSPACE#one", "EVENT#one#00000001", {
      value: { projectName: "tool payload" },
    }), reencrypt).item;
    expect(event.value).toEqual({ projectName: "tool payload" });
    const job = convertLegacyAgentItem(row("PROJECT#writer", "AUDIOJOB#one", {
      entityType: "AudioJob", job: { projectName: "writer", postprocess: { projectName: "summarizer" },
        sourceRefresh: { projectName: "source" }, actor: { kind: "project-token" } },
    }), reencrypt).item;
    expect(job.job).toMatchObject({ agentName: "writer", postprocess: { agentName: "summarizer" },
      sourceRefresh: { agentName: "source" }, actor: { kind: "agent-token" } });
    const receipt = convertLegacyAgentItem(row("PROJECT#writer", "USAGERECEIPT#one", {
      entityType: "UsageReceipt", delta: { projectName: "writer", actor: "project-token:owner@example.test" },
    }), reencrypt).item;
    expect(receipt.delta).toEqual({ agentName: "writer", actor: "agent-token:owner@example.test" });
  });

  it("refuses an old/new field collision instead of dropping either value", () => {
    expect(() => convertLegacyAgentItem(row("PROJECT#writer", "META", {
      entityType: "PROJECT", name: "writer", projectName: "writer", agentName: "other",
    }), reencrypt)).toThrow(/field collision/);
  });

  it("refuses an Agent-scoped ciphertext whose address has not been converted", () => {
    expect(() => convertLegacyAgentItem(row("PROJECT#writer", "UNRECOGNIZED", {
      entityType: "UnknownAgentRow", credential: "enc:v2:opaque",
    }), reencrypt)).toThrow(/unconverted encrypted field/);
  });

  it("refuses a stored Agent identity that would bind secrets to the wrong name", () => {
    expect(() => convertLegacyAgentItem(row("PROJECT#writer", "META", {
      entityType: "PROJECT", name: "other", configuration: { projectName: "writer" },
    }), reencrypt)).toThrow(/disagrees with its partition key/);
  });
});
