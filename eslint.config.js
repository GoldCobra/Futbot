const js = require('@eslint/js');
const globals = require('globals');

// Correctness rules only (undefined names, unused code, unreachable code);
// formatting is left as it is.
module.exports = [
    { ignores: ['node_modules/', 'coverage/', 'runtime/'] },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: { globals: { ...globals.jest } }
    }
];
