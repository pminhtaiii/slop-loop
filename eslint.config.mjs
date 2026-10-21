import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeJavaScript = [
  'scripts/**/*.mjs',
  'tests/agents/**/*.mjs',
  'tests/ci/**/*.mjs',
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.agent-work/**',
      'coverage/**',
    ],
  },
  {
    ...js.configs.recommended,
    files: nodeJavaScript,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: globals.nodeBuiltin,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [
      tseslint.configs.eslintRecommended,
      ...tseslint.configs.strict,
      ...tseslint.configs.stylistic,
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'prefer-const': 'error',
    },
  }
);
