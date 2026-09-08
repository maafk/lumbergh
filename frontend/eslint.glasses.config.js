// Lints ../glasses, the dependency-free ES-module HUD page, without pulling it
// into the Vite app's TS-oriented eslint.config.js. Invoked explicitly by
// lint.sh with cwd at the repo root — see the basePath override below.
import js from '@eslint/js'
import globals from 'globals'
import { defineConfig } from 'eslint/config'
import eslintConfigPrettier from 'eslint-config-prettier'

export default defineConfig([
  // Flat config only lints files at or below the config file's own directory
  // by default; glasses/ is a sibling of frontend/, so the base path has to
  // be raised to the repo root explicitly.
  { basePath: '..' },
  // Third-party, obfuscated, and shipped verbatim — linting it would only report on
  // someone else's build output. See glasses/vendor/README.md for why it is vendored.
  { ignores: ['glasses/vendor/**'] },
  {
    files: ['glasses/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  eslintConfigPrettier,
])
