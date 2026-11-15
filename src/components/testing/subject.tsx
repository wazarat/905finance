import { ChainLink } from "@/components/goat/chain-link";
import type { JobSource } from "@/db/schema";
import { getFixture } from "@/lib/capabilities";

/** What a job or a watch looks at: a bundled project, or something the buyer shared. */
export function Subject({ source, fixtureKey }: { source: JobSource | null; fixtureKey: string }) {
  if (!source) return <>Bundled fixture · {getFixture(fixtureKey)?.label ?? fixtureKey}</>;
  if (source.kind === "github") {
    return (
      <>
        Shared repository ·{" "}
        <a
          href={`https://github.com/${source.owner}/${source.repo}`}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-4 hover:text-foreground"
        >
          {source.owner}/{source.repo}
        </a>
        . Read, never run.
      </>
    );
  }
  if (source.kind === "files") return <>Shared files. Read, never run.</>;
  if (source.kind === "website") {
    return (
      <>
        Website · <span className="figure break-all">{source.url}</span>. Looked at as a visitor would; nothing submitted.
      </>
    );
  }
  return (
    <>
      {source.addresses.length} {source.addresses.length === 1 ? "address" : "addresses"} on GOAT Testnet3, read from
      the chain:{" "}
      {source.addresses.map((address) => (
        <span key={address} className="mr-2 inline-block">
          <ChainLink value={address} short />
        </span>
      ))}
    </>
  );
}
