// Flat config for ESLint 9+ — applies to nodes/**/*.ts + credentials/**/*.ts
// Generated 2026-05-05 to close the fleet-wide "ESLint couldn't find a config file" gap.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'tests/**',
      '__tests__/**',
      'src/generated/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['nodes/**/*.ts', 'credentials/**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // Node generators emit `@ts-ignore` above ICredentialType.test() because
      // n8n-workflow's .d.ts doesn't expose `test` even though it is supported at
      // runtime. Switching this to `@ts-expect-error` would require regenerating
      // every node; track separately.
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
);
