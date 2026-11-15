import parser from "@typescript-eslint/parser";
import security from "eslint-plugin-security";

/**
 * The rule set for a security scan: every rule of eslint-plugin-security, and
 * nothing else. It is the worker's own; a project's lint configuration and
 * its inline "eslint-disable" comments are ignored, so the code being scanned
 * cannot switch a rule off.
 */
const rules = Object.fromEntries(Object.keys(security.rules).map((name) => [`security/${name}`, "error"]));

const config = [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { security },
    rules,
  },
];

export default config;
