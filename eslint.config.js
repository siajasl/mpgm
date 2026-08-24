import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  eslint.configs.recommended,

  // Type-aware linting for everything covered by tsconfig.json. The rules that
  // matter most here are no-floating-promises / no-misused-promises: the kernel
  // is an async fold over an append-only log (DESIGN ADR-2), and a dropped
  // promise there is a silently lost event.
  {
    files: ['src/**/*.ts', 'vitest.config.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // A leading underscore marks a binding that exists only to be discarded --
  // destructuring a key out of an object is the common case.
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // This config file itself is not part of the TS project.
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Node entry points and demo scripts: plain JS run against the build.
  {
    files: ['scripts/**/*.mjs', 'bin/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },

  // Test fixtures executed by a subprocess: plain JS, run against the build.
  {
    files: ['**/__fixtures__/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', setInterval: 'readonly' },
    },
  },

  prettier,
);
