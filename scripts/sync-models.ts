/** Refresh offline display metadata; execution still uses explicitly registered models only. */
import { readFile, writeFile } from "node:fs/promises";
import { parsePublishedModelFacts } from "@/infrastructure/llm/publishedModelFacts";
import { readBodyBytes } from "@/shared/httpBody";

const target = new URL("../src/infrastructure/llm/data/publishedModels.json", import.meta.url);
const source = "https://models.opspresso.com/models.json";
async function main() {
  const args = process.argv.slice(2);
  const from = args.indexOf("--from");
  if (from >= 0 && (!args[from + 1] || args[from + 1]!.startsWith("--"))) throw new Error("--from requires a file");
  const signal = AbortSignal.timeout(30_000);
  const document = from >= 0 ? JSON.parse(await readFile(args[from + 1]!, "utf8")) : await (async () => {
    const response = await fetch(source, { signal, redirect: "error" });
    if (!response.ok) throw new Error(`Model catalog refresh failed (HTTP ${response.status})`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBodyBytes(response, 4 * 1024 * 1024, signal)));
  })();
  const next = parsePublishedModelFacts(document);
  if (args.includes("--check")) {
    const current = JSON.parse(await readFile(target, "utf8"));
    if (current.updatedAt !== next.updatedAt) throw new Error("Published model facts are outdated; run pnpm sync-models");
  } else {
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
  }
  console.log(`Published model facts: ${next.models.length} models, ${next.updatedAt}`);
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
