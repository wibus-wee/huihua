import { defineConfig } from 'eslint-config-hyoban'

export default defineConfig({
  ignores: ['fixtures/**', 'dist/**', 'pnpm-lock.yaml'],
  react: false,
  vue: false,
  // The repository uses Node's built-in test runner, not Vitest.
  test: { overrides: { 'test/no-import-node-test': 'off', 'test/prefer-lowercase-title': 'off' } },
  typescript: {
    tsconfigPath: './tsconfig.tests.json',
    parserOptions: { projectService: false, project: './tsconfig.tests.json' },
    overrides: { 'ts/no-explicit-any': 'error' },
  },
}, {
  linterOptions: { noInlineConfig: true },
  rules: {
    // Hoisting every small literal regex obscures parsing code without measured benefit.
    'e18e/prefer-static-regex': 'off',
    'ts/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-expect-error': true, 'ts-nocheck': true, 'ts-check': false }],
  },
}, {
  files: ['src/**/*.ts'],
  rules: { 'no-console': 'error' },
}, {
  // Node-owned tools and tests report validation results to the terminal.
  files: ['tools/**/*.ts', 'tests/**/*.ts'],
  rules: { 'no-console': 'off', 'antfu/no-top-level-await': 'off' },
}, {
  // Documentation snippets are isolated examples, not members of the compiled TypeScript project.
  files: ['**/*.md/**'],
  languageOptions: { parserOptions: { project: false, projectService: false } },
})
