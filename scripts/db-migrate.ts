/**
 * Bring a database to the current schema without starting the app — what a
 * CI job or an operator runs before a first boot, and what the app itself
 * runs at every boot.
 *
 *   pnpm db:migrate                                   # DATABASE_URL from the environment
 *   pnpm tsx --env-file=.env.local scripts/db-migrate.ts
 */
process.env.STAGE ??= "local";
process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@localhost:5432/agent_studio";

async function main() {
  const { migrate, SCHEMA_VERSION } = await import("@/infrastructure/db/migrations");
  await migrate();
  console.log(`schema at version ${SCHEMA_VERSION}`);
  const { closePool } = await import("@/infrastructure/db/client");
  await closePool();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {};
