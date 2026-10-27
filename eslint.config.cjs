const typescriptEslint = require("typescript-eslint");

module.exports = [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...typescriptEslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    },
  },
];
