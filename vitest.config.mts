/**
 * `.mts` makes this config ESM for `import.meta.url` without changing the
 * module interpretation of other JavaScript files in the package.
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
     * Restore spies even after failed assertions so later tests retain their
     * original dependencies and diagnostic output.
     */
    restoreMocks: true,
  },
});
