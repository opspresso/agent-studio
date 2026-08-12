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
