/**
 * The one definition of who may access an agent — see and run it, clone it,
 * read what it produced. Every surface that gates by visibility (console
 * routes, chat runs, the Slack bot's email check) asks this predicate;
 * a second reading of `visibility` or `memberEmails` as an access decision is
 * the drift this file exists to prevent. Pure on purpose: the admin override
 * needs I/O, so it lives in the application layer
 * (`assertAgentAccessible`), composed *around* this answer — never inside a
 * copy of it.
 */

import type { Agent } from "./types";

/** What the access decision reads — narrower than a full row on purpose. */
export type AgentAccessFields = Pick<Agent, "ownerEmail" | "visibility" | "memberEmails">;

/** Absent means public — the shape every agent had before visibility. */
export function isAgentPrivate(agent: AgentAccessFields): boolean {
  return agent.visibility === "private";
}

/**
 * May this email see and run the agent? Owner always; everyone signed in
 * while it is public; the invited list while it is private. Emails compare
 * case-insensitively: the stored side is normalized on write, but the asking
 * side arrives from OAuth, Slack profiles and typed invites, which disagree
 * about case for the same mailbox.
 */
export function mayAccessAgent(agent: AgentAccessFields, email: string): boolean {
  if (!isAgentPrivate(agent)) {
    return true;
  }
  const asking = email.toLowerCase();
  if (agent.ownerEmail.toLowerCase() === asking) {
    return true;
  }
  return (agent.memberEmails ?? []).some((member) => member.toLowerCase() === asking);
}

/**
 * A submitted invite list in its stored form: trimmed, lowercased,
 * deduplicated, the owner dropped (ownership itself is the access, and a
 * listed owner would survive an ownership transfer as a stale grant).
 */
export function normalizeMemberEmails(emails: string[], ownerEmail: string): string[] {
  const owner = ownerEmail.toLowerCase();
  return [...new Set(emails.map((email) => email.trim().toLowerCase()))].filter(
    (email) => email.length > 0 && email !== owner,
  );
}
