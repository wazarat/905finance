/** Runs once when the server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertSafeAuthConfiguration, missingConfiguration } = await import("@/server/env");
    assertSafeAuthConfiguration();
    const missing = missingConfiguration();
    if (missing.length > 0) {
      console.warn(
        `905 Finance is missing configuration:\n${missing.map((item) => `  - ${item}`).join("\n")}`,
      );
    }
  }
}
