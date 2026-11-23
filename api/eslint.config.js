const js = require('@eslint/js');

module.exports = [
    js.configs.recommended,
    {
        ignores: ['ecosystem.config.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                console: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                __dirname: 'readonly',
                fetch: 'readonly',
                AbortController: 'readonly',
                TextDecoder: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', { avoidEscape: true }],
            'indent': ['error', 4],
            'comma-dangle': ['error', 'never'],
            'object-curly-spacing': ['error', 'always'],
            'array-bracket-spacing': ['error', 'never'],
            'arrow-spacing': 'error',
            'eqeqeq': 'error',
            'curly': 'error',
            'dot-notation': 'error',
            'no-dupe-keys': 'error',
            'no-unreachable': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',
            'no-eval': 'error',
            'no-with': 'error',
            'no-var': 'warn',
            'prefer-const': 'warn',
            'prefer-template': 'warn'
        }
    }
];
