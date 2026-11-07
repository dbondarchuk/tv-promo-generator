const { resolve } = require("node:path");
const prettierConfig = require("eslint-config-prettier/flat");
const eslintPluginPrettierRecommended = require("eslint-plugin-prettier/recommended");
const tsParser = require("@typescript-eslint/parser");
const paddingLines = require("./eslint/rules/padding-lines");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  prettierConfig,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      parser: tsParser,
      globals: {
        React: true,
        JSX: true,
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: [
            resolve(__dirname, "tsconfig.base.json"),
            resolve(__dirname, "server/tsconfig.json"),
            resolve(__dirname, "client/tsconfig.json"),
            resolve(__dirname, "packages/shared/tsconfig.json"),
          ],
        },
      },
    },
    files: ["**/*.js?(x)", "**/*.ts?(x)", "**/*.mjs", "**/*.cjs"],
  },
  {
    ignores: [
      ".*.js",
      "node_modules/",
      "**/node_modules/",
      "dist/",
      "**/dist/",
      "build/",
      "coverage/",
      "cache/",
      "output/",
      "config/",
      "tools/",
      "client/dist/",
      "server/dist/",
      "server/cache/",
      "packages/shared/dist/",
      "**/*.tsbuildinfo",
    ],
  },
  {
    plugins: {
      promo: {
        rules: {
          "padding-lines": paddingLines,
        },
      },
    },
    rules: {
      // Matches .cursor/rules/code-style.mdc (same rule as hacado).
      // Warn until a fix pass; `eslint --fix` / save still apply it.
      "promo/padding-lines": "warn",
    },
  },
];
