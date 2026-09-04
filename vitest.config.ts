import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against TypeScript source rather than build output, so a failing
    // test points at the line you edited and no build step sits between the two.
    alias: {
      '@idfkit/schemas/node': here('./packages/schemas/src/node.ts'),
      '@idfkit/schemas': here('./packages/schemas/src/index.ts'),
      '@idfkit/core/node': here('./packages/core/src/node.ts'),
      '@idfkit/core': here('./packages/core/src/index.ts'),
      '@idfkit/language': here('./packages/language/src/index.ts'),
      '@idfkit/weather/node': here('./packages/weather/src/node.ts'),
      '@idfkit/weather': here('./packages/weather/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
