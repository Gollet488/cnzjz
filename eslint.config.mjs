import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import ts from 'typescript-eslint';
import globals from 'globals';

export default ts.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'public/mediapipe/**',
      'public/ffmpeg/**',
      '.qa/**',
      '.delivery/**',
      'docs/evidence/**',
      'test-results/**',
      'playwright-report/**',
      '.demo/**',
      '.pnpm-store/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
    rules: {
      // JSON/tool boundaries are validated at runtime by analysis/schema.ts.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } } },
);
