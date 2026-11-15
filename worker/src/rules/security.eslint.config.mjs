import parser from "@typescript-eslint/parser";
import security from "eslint-plugin-security";

/**
 * The rule set for a security scan: every rule of eslint-plugin-security, and
 * nothing else. It is the worker's own; a project's lint configuration and
 * its inline "eslint-disable" comments are ignored, so the code being scanned
 * cannot switch a rule off.
 */
/**
 * Left out: detect-object-injection flags every property read with a computed
 * key, which in ordinary code is nearly all of them, and buries the rest.
 */
const LEFT_OUT = new Set(["detect-object-injection"]);
const rules = Object.fromEntries(
  Object.keys(security.rules)
    .filter((name) => !LEFT_OUT.has(name))
    .map((name) => [`security/${name}`, "error"]),
);

const config = [
  {
    // Code a project did not write, or did not write by hand.
    ignores: [
      "**/node_modules/**",
      "**/vendor/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/.next/**",
      "**/coverage/**",
      "**/*.min.js",
      "**/*.d.ts",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      parser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { security },
    rules,
  },
];

export default config;
