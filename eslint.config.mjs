// Shared lint for every bundled plugin. The plugins are plain CommonJS Node modules with no
// build step, so this is the only static guard they get; it carries the one rule the host
// application enforces on its own code and cannot enforce here from outside: a catch block must
// not make a failure disappear (see lint-rules/no-silent-catch.mjs).
import js from '@eslint/js'
import globals from 'globals'
import noSilentCatchRules from './lint-rules/no-silent-catch.mjs'

export default [
  {
    ignores: [
      '**/node_modules/**',
      // .NET plugin hosts ship their own compiled output; not JavaScript to lint.
      '**/bin/**',
      '**/obj/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      // The plugins mix CommonJS (`require`) and ES modules (`import`) across .js files, and the
      // host loads both. Module mode parses either (CommonJS files simply never use `import`),
      // and the Node globals set covers `require`/`module`/`exports`, so one setting serves all.
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { local: { rules: noSilentCatchRules } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      'local/no-silent-catch': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Test bodies routinely catch just to assert on the error - not a silent-failure risk.
    files: ['**/*.test.js', '**/__tests__/**'],
    rules: { 'local/no-silent-catch': 'off', 'no-empty': 'off' },
  },
]
