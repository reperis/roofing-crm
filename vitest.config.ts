import { defineConfig } from 'vitest/config';

/**
 * Coverage thresholds for the workspace.
 *
 * Deliberately set at what the suite actually reaches today rather than an aspirational number.
 * A threshold above the real figure fails CI on day one and gets lowered until it means nothing;
 * a threshold at the real figure is a ratchet — it cannot fall without someone noticing, which is
 * the only property that matters here.
 *
 * The measured surface is narrow on purpose. Coverage is reported for the logic that decides
 * things — lead scoring, the query predicates, the lead store, the schemas — and not for view
 * components, generated CDK output or scripts, where a percentage would measure how much JSX a
 * test happened to render rather than whether anything is verified.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      include: [
        'packages/shared/src/**',
        'packages/schema/src/**',
        'apps/api/src/leads/store.ts',
        'apps/web/src/data/queries.ts',
      ],
      // Measured, not aspirational: 84.87 / 79.1 / 76 / 84.48 today. Set just beneath so the
      // gate is a ratchet rather than a wish — it cannot slip without someone being told.
      thresholds: {
        statements: 82,
        branches: 77,
        functions: 74,
        lines: 82,
      },
    },
  },
});
