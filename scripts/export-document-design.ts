import { writeFileSync } from "node:fs";
import { documentDesignCatalog } from "../src/infrastructure/documents/engine/write/catalog";

const outputs = process.argv.slice(2);
const json = JSON.stringify(documentDesignCatalog(), null, 2) + "\n";
if (outputs.length === 0) process.stdout.write(json);
else for (const path of outputs) writeFileSync(path, json);
