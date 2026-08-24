/**
 * `.mts` rather than `.ts`: this file is ESM (`import.meta.url`) and the
 * package is not declared one, so a `.ts` config is loaded as CommonJS. Vite's
 * compatibility loader still reads it today and warns that the native loader —
 * the planned default — will not, which is a test run that stops working on a
 * dependency bump. The extension says what the file is, and needs no `type`
 * field that would reinterpret every other `.js` in the repository.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    /**
     * Spies are put back after every test, whatever the test did.
     *
     * Several files install a `console` spy and restore it *after* their
     * assertions, so a failing assertion left the spy in place for the rest of
     * the file — the one failure then swallowed the diagnostic output of every
     * test after it, which is exactly when that output is worth most. Others
     * never restored at all.
     */
    restoreMocks: true,
  },
});
