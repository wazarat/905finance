import { explorerLink, shortAddress } from "@/lib/goat";
import { cn } from "@/lib/utils";

/**
 * An address or transaction hash, linked to the GOAT Testnet3 explorer when
 * it is one. Anything else (a simulated reference, for instance) is shown as
 * plain text, so a simulated record never looks like it is on a chain.
 */
export function ChainLink({
  value,
  short = false,
  className,
}: {
  value: string;
  short?: boolean;
  className?: string;
}) {
  const href = explorerLink(value);
  const text = short && href ? shortAddress(value) : value;
  if (!href) return <span className={cn("figure break-all", className)}>{text}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={`${value} · open in the GOAT Testnet3 explorer`}
      className={cn("figure break-all underline decoration-border underline-offset-4 hover:decoration-foreground", className)}
    >
      {text}
    </a>
  );
}
