import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.mpgm/**` is the kernel's machine-local runtime state (ADR-2) — the event
  // log, and a git worktree per in-flight task. eslint descends into it: with
  // flat config there is no dotfile exemption, so a task's unmerged source gets
  // linted as if it were this checkout's own.
  //
  // That makes `npm run lint` fail for reasons no change here can fix, and CI
  // cannot reproduce it because `.mpgm/` is gitignored and a fresh checkout has
  // none. A local red that CI calls green is worse than either: it trains the
  // reader to disbelieve the check.
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.mpgm/**'] },

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
        // The CLI demo drives `mpgm serve` the way anything else would: start
        // it, ask it over HTTP, stop it.
        AbortController: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
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
