import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/cli/start.ts',
        'src/lib/logger.ts',
      ],
      thresholds: {
        lines: 70,
      },
    },
  },
});
