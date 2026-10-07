import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
  resolve: {
    // Test the agent against the checker's source, not a possibly stale build.
    alias: [
      {
        find: /^@simonlunay\/redline\/node$/,
        replacement: src('./packages/checker/src/node/index.ts'),
      },
      { find: /^@simonlunay\/redline$/, replacement: src('./packages/checker/src/core/index.ts') },
      {
        find: /^@simonlunay\/redline-agent\/node$/,
        replacement: src('./packages/agent/src/node/index.ts'),
      },
      { find: /^@simonlunay\/redline-agent$/, replacement: src('./packages/agent/src/index.ts') },
    ],
  },
});
