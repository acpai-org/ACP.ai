import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Non-application trees that should not be linted:
    "node_modules/**",
    ".kilo/**",
    "extracted/**",
    "attestcoin-protocol-examples/**",
    "developer docs/**",
    "mini-services/**",
    "examples/**",
    "skills/**",
    "download/**",
    "upload/**",
    "tool-results/**",
    "sqlite.db*",
  ]),
]);

export default eslintConfig;
