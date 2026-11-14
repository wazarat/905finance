"use client";

import { useEffect } from "react";

/**
 * Last-resort fallback when the root layout itself fails. It replaces the whole
 * document, so it carries its own minimal styling in the site's colours.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#070b14",
          color: "#f2f0e9",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <title>Something went wrong · 905 Finance</title>
        <main role="alert" style={{ maxWidth: 440 }}>
          <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.14em", color: "#ffc55c" }}>ERROR</p>
          <h1 style={{ margin: "12px 0 0", fontSize: 28, lineHeight: 1.2 }}>Something went wrong</h1>
          <p style={{ margin: "12px 0 0", lineHeight: 1.6, color: "#8d97ab" }}>
            905 Finance couldn&apos;t load this page. It&apos;s a problem on our side, not something
            you did.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              marginTop: 28,
              height: 40,
              padding: "0 16px",
              border: 0,
              borderRadius: 10,
              background: "#2bff88",
              color: "#03140a",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {digest ? (
            <p style={{ margin: "28px 0 0", fontSize: 12, color: "#8d97ab" }}>Reference {digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
