const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'logs/', 'backups/', 'docs/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      // variables:false = solo avisa si se usa antes de declararse en el mismo ámbito (el bug de irc-ratelimit); los usos dentro de funciones son seguros
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Los regex de quality.js llevan escapes defensivos a propósito
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
