import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The core must run in the browser too, so Node built-ins are banned there.
    // This turns "isomorphic" from a convention into something CI enforces.
    files: ['packages/checker/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'url', 'os', 'child_process', 'buffer', '@napi-rs/*'],
              message: 'src/core must stay isomorphic. Put Node-specific code in src/node.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname', 'require'],
    },
  },
);
