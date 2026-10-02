import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Member } from "@/domain/member/types";
import type { SlackEventBody } from "@/application/slack/types";
import { authorizeSlackKeywordEvent } from "@/application/slack/keywordExecution";
import { assertExecutionGrant, type ExecutionGrantDeps } from "@/application/auth/authorizeExecutionGrant";
import { assertRunIdentity } from "@/application/auth/authorizeRunIdentity";

const agent: Agent = { name: "sre", displayName: "SRE", description: "", ownerEmail: "owner@example.test",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  slack: { enabled: true, botToken: "encrypted", signingSecret: "encrypted", channelKeywords: ["[firing:"],
    keywordExecution: { userId: "registrant", revision: "r1" } } };
const member: Member = { id: "registrant", name: "Registrant", email: "registrant@example.test", tier: "member", image: null,
  joinedAt: "2026-01-01T00:00:00Z", lastLoginAt: null };
const alert: SlackEventBody = { type: "event_callback", team_id: "T1", authorizations: [{ user_id: "U_SELF", is_bot: true }],
  event: { type: "message", subtype: "bot_message", bot_id: "B_ALERT", channel: "C1", channel_type: "channel", ts: "1.0",
    attachments: [{ title: "[FIRING:1] OOMKilled" }] } };

function fixture() {
  const get = vi.fn(async (): Promise<Agent | null> => agent);
  const getById = vi.fn(async (): Promise<Member | null> => member);
  const resolve = vi.fn();
  const deps: ExecutionGrantDeps = { agents: { get } as unknown as AgentRepository, members: { getById }, messagingIdentities: { resolve },
    triggers: { get: vi.fn() }, webhookCredentials: { authorize: vi.fn() }, apiCredentials: { authorize: vi.fn() } };
  return { deps, get, getById, resolve };
}

describe("Slack channel-keyword execution", () => {
  it("rechecks automation registration through the shared grant dispatcher without a human messaging connection", async () => {
    const { deps, getById, resolve } = fixture();
    const grant = await authorizeSlackKeywordEvent(deps, "sre", alert);
    expect(grant).toMatchObject({ kind: "slack", source: "channel-keyword", userId: "registrant", externalId: "B_ALERT" });
    assertRunIdentity({ user: { userId: grant.userId, email: grant.email }, actor: { kind: "slack", id: "B_ALERT" }, executionGrant: grant });
    await assertExecutionGrant(deps, grant);
    expect(getById).toHaveBeenCalledWith("registrant");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("accepts a keyword alert delivered as an app mention without granting unrelated mentions", async () => {
    const { deps } = fixture();
    const mention = { ...alert, event: { ...alert.event, type: "app_mention", text: "<@U_SELF> triage this alert" } };
    await expect(authorizeSlackKeywordEvent(deps, "sre", mention)).resolves.toMatchObject({ source: "channel-keyword", userId: "registrant" });
    await expect(authorizeSlackKeywordEvent(deps, "sre", { ...mention, event: { ...mention.event, attachments: [] } }))
      .rejects.toThrow("not authorized");
  });

  it.each([
    { enabled: false }, { channelKeywords: [] }, { keywordExecution: undefined },
    { keywordExecution: { userId: "replacement", revision: "r1" } },
    { keywordExecution: { userId: "registrant", revision: "r2" } },
  ])("revokes a captured grant when registration changes: %j", async changed => {
    const { deps, get } = fixture();
    const grant = await authorizeSlackKeywordEvent(deps, "sre", alert);
    get.mockResolvedValue({ ...agent, slack: { ...agent.slack!, ...changed } });
    await expect(assertExecutionGrant(deps, grant)).rejects.toThrow("permission changed");
  });

  it.each([null, { ...member, id: "replacement" }, { ...member, tier: "guest" as const }])("refuses missing or ineligible registering accounts", async current => {
    const { deps, getById } = fixture();
    const grant = await authorizeSlackKeywordEvent(deps, "sre", alert);
    getById.mockResolvedValue(current);
    await expect(assertExecutionGrant(deps, grant)).rejects.toThrow();
    await expect(authorizeSlackKeywordEvent(deps, "sre", alert)).rejects.toThrow();
  });

  it("rechecks private Agent access and current email without assuming the Agent owner", async () => {
    const { deps, get, getById } = fixture();
    const grant = await authorizeSlackKeywordEvent(deps, "sre", alert);
    getById.mockResolvedValue({ ...member, email: "changed@example.test" });
    await expect(assertExecutionGrant(deps, grant)).rejects.toThrow("permission changed");
    getById.mockResolvedValue(member);
    get.mockResolvedValue({ ...agent, visibility: "private" });
    await expect(authorizeSlackKeywordEvent(deps, "sre", alert)).rejects.toThrow();
  });

  it.each([
    { user: "U_SELF" }, { text: "ordinary app message", attachments: [] },
    { thread_ts: "0.9" }, { channel_type: "im" }, { bot_id: undefined, user: "U1" },
  ])("does not grant automation to unrelated messages or bot loops: %j", async changed => {
    const { deps } = fixture();
    await expect(authorizeSlackKeywordEvent(deps, "sre", { ...alert, event: { ...alert.event, ...changed } }))
      .rejects.toThrow("not authorized");
  });
});
