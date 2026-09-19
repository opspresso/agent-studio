import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AgentMigrationError, applyAgentMigration, migrationProjectNames, planAgentMigration } from "./agent-configuration-migration";

const overridesSchema = z.object({
  model: z.string().min(1).optional(), imageModel: z.string().min(1).optional(), fallbackModel: z.string().min(1).nullable().optional(),
  systemPrompt: z.string().optional(), discardUserPromptTemplate: z.boolean().optional(),
}).strict();

async function main() {
  const { values } = parseArgs({ options: {
    project: { type: "string" }, overrides: { type: "string" }, apply: { type: "boolean" },
    expect: { type: "string" }, offline: { type: "boolean" },
  } });
  if (!process.env.DATABASE_URL) throw new AgentMigrationError("Set DATABASE_URL explicitly");
  if (values.apply && (!values.project || !values.expect || !values.offline)) {
    throw new AgentMigrationError("Apply requires --project NAME --expect FINGERPRINT --offline after stopping app, workers and inbound traffic");
  }
  if (values.overrides && !values.project) throw new AgentMigrationError("Overrides require --project");
  const overrides = values.overrides ? overridesSchema.parse(JSON.parse(await readFile(values.overrides, "utf8"))) : {};
  if (values.apply) {
    const { secretCipher } = await import("@/infrastructure/crypto/secretCipher");
    console.log(JSON.stringify(await applyAgentMigration(values.project!, values.expect!, secretCipher, overrides)));
  } else if (values.project) {
    console.log(JSON.stringify(await planAgentMigration(values.project, overrides)));
  } else {
    for await (const name of migrationProjectNames()) console.log(JSON.stringify(await planAgentMigration(name)));
  }
}

main().catch((error: unknown) => {
  // Connection strings and malformed override contents can contain credentials.
  console.error(error instanceof AgentMigrationError ? error.message
    : "Agent migration failed. Check the arguments, plan, database connection and encryption key; no secrets are printed.");
  process.exitCode = 1;
}).finally(async () => {
  const { closePool } = await import("@/infrastructure/db/client");
  await closePool();
});
