import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintConfigNext from 'eslint-config-next';

export default tseslint.config(
  // 1. Global ignores
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/.next/',
      '**/*.js',
      '**/*.mjs',
    ],
  },

  // 2. Type-checked TypeScript rules scoped to package source files
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // 3. Next.js rules scoped to web package only
  ...eslintConfigNext.map((config) => ({
    ...config,
    ...(config.files !== undefined
      ? { files: config.files.map((p) => `packages/web/${p}`) }
      : {}),
  })),

  // 4. Prettier must be last
  eslintConfigPrettier,
);
