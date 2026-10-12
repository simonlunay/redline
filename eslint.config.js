import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/web/.next/**',
      'apps/web/out/**',
      'apps/web/public/**',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The core must run in the browser too, so Node built-ins are banned there.
    // This turns "isomorphic" from a convention into something CI enforces.
    files: [
      'packages/checker/src/core/**/*.ts',
      'packages/agent/src/**/*.ts',
      'packages/generate/src/**/*.ts',
    ],
    ignores: ['packages/agent/src/node/**', 'packages/generate/src/node/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'url', 'os', 'child_process', 'buffer', '@napi-rs/*'],
              message: 'This code must stay isomorphic. Put Node-specific code in src/node.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname', 'require'],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Node scripts of the web app (plain ESM, no TypeScript globals).
    files: ['apps/web/scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
