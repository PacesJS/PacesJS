import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'docs/**',
      'coverage/**',
      'zoo/**',
      'packages/paces/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  // engine and format must run anywhere: no Node built-ins (R1).
  {
    files: ['packages/engine/src/**', 'packages/format/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'child_process', 'worker_threads'],
              message: 'engine and format must not import Node built-ins.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: [
      'packages/{paces,collector-node,collector-browser,shared}/**/*.ts',
      'scripts/**',
      'e2e/**',
      '*.config.*',
    ],
    languageOptions: { globals: globals.node },
  },
  // The injected page script runs in the browser.
  {
    files: ['packages/collector-browser/src/inject/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  // The CLI prints to the terminal on purpose.
  { files: ['packages/paces/src/**', 'scripts/**', 'e2e/**'], rules: { 'no-console': 'off' } },
);
