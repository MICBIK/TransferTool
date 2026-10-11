import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'server/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: { 'vue/multi-word-component-names': 'off', 'vue/max-attributes-per-line': 'off', 'vue/singleline-html-element-content-newline': 'off', 'vue/html-self-closing': 'off', 'vue/html-closing-bracket-newline': 'off', 'vue/html-indent': 'off', 'vue/attributes-order': 'off' },
  },
  { files: ['server/**/*.ts', '*.js'], languageOptions: { globals: globals.node } },
  { files: ['web/**/*.{ts,vue}'], languageOptions: { globals: globals.browser } },
);
