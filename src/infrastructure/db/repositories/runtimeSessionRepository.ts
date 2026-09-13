import type { RuntimeSessionRepository, RuntimeSessionRow } from "@/domain/execution/runtimeSession";
import { sql } from "../client";
import { expiresAtFromNow, RUN_LOG_TTL_SECONDS } from "../ttl";

interface StoredRow {
  session_id: string;
  owner_email: string;
  project_name: string;
  revision: string | number;
  payload: string;
  expires_at: Date;
}

export const runtimeSessionRepository: RuntimeSessionRepository = {
  async get(sessionId, ownerEmail) {
    const [row] = await sql<StoredRow>(
      "SELECT session_id, owner_email, project_name, revision, payload, expires_at FROM runtime_sessions WHERE session_id = $1 AND owner_email = $2 AND expires_at > now() AND NOT deleted",
      [sessionId, ownerEmail],
    );
    return row ? {
      sessionId: row.session_id, ownerEmail: row.owner_email, projectName: row.project_name,
      revision: Number(row.revision), payload: row.payload, expiresAt: row.expires_at.toISOString(),
    } satisfies RuntimeSessionRow : null;
  },
  async save(row, expectedRevision) {
    const values = [row.sessionId, row.ownerEmail, row.projectName, row.payload, row.expiresAt];
    const rows = expectedRevision === null
      ? await sql<{ revision: string }>(
        `INSERT INTO runtime_sessions (session_id, owner_email, project_name, payload, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at,
           revision = runtime_sessions.revision + 1, updated_at = now()
         WHERE NOT runtime_sessions.deleted AND runtime_sessions.expires_at <= now() AND runtime_sessions.owner_email = EXCLUDED.owner_email
           AND runtime_sessions.project_name = EXCLUDED.project_name RETURNING revision`, values,
      )
      : await sql<{ revision: string }>(
        `UPDATE runtime_sessions SET payload = $4, expires_at = $5, revision = revision + 1, updated_at = now()
         WHERE session_id = $1 AND owner_email = $2 AND project_name = $3 AND revision = $6 AND expires_at > now() AND NOT deleted
         RETURNING revision`, [...values, expectedRevision],
      );
    return rows[0] ? Number(rows[0].revision) : null;
  },
  async delete(sessionId, ownerEmail) {
    // A tombstone fences a run that finishes after its chat was deleted.
    await sql(`INSERT INTO runtime_sessions (session_id, owner_email, project_name, payload, deleted, expires_at)
      VALUES ($1, $2, '', '', true, $3)
      ON CONFLICT (session_id) DO UPDATE SET payload = '', deleted = true, revision = runtime_sessions.revision + 1,
        expires_at = $3
      WHERE runtime_sessions.owner_email = $2`, [sessionId, ownerEmail, new Date(expiresAtFromNow(RUN_LOG_TTL_SECONDS) * 1000)]);
  },
  async sweepExpired(now) {
    const rows = await sql<{ session_id: string }>(
      `DELETE FROM runtime_sessions WHERE session_id IN
       (SELECT session_id FROM runtime_sessions WHERE expires_at <= $1 ORDER BY expires_at LIMIT 1000)
       RETURNING session_id`, [now],
    );
    return rows.length;
  },
};
