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

  // This config file itself is not part of the TS project.
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
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
