import { createRequire } from "node:module";
import { toolVersion } from "./exec.mjs";

const require = createRequire(import.meta.url);

/**
 * The testing tools this worker has, with the version each one reports.
 * A tool that is not installed is null, and the worker then never claims
 * work that needs it.
 */
export async function detectTools() {
  let vitest = null;
  try {
    vitest = `vitest ${require("vitest/package.json").version}`;
  } catch {
    // Not installed.
  }
  // The security scan needs ESLint, the security rules and the TypeScript parser together.
  let eslint = null;
  try {
    const rules = require("eslint-plugin-security/package.json").version;
    require.resolve("@typescript-eslint/parser");
    eslint = `eslint ${require("eslint/package.json").version}, eslint-plugin-security ${rules}`;
  } catch {
    // Not installed.
  }
  let solhint = null;
  try {
    solhint = `solhint ${require("solhint/package.json").version}`;
  } catch {
    // Not installed.
  }
  // The website and contract checks are this worker's own code, and need nothing installed.
  const own = require("../package.json").version;
  const [forge, slither] = await Promise.all([toolVersion("forge"), toolVersion("slither")]);
  return { vitest, forge, slither, eslint, solhint, webcheck: `website check ${own}`, chaincheck: `contract check ${own}` };
}
