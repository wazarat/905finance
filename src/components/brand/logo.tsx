import Link from "next/link";
import { cn } from "@/lib/utils";

/** 905 Finance wordmark: a green authorization tick inside a square, then the name. */
export function Logo({ className, href = "/" }: { className?: string; href?: string | null }) {
  const mark = (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg
        width="26"
        height="26"
        viewBox="0 0 26 26"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect x="1" y="1" width="24" height="24" rx="6" stroke="var(--brand)" strokeWidth="1.5" />
        <path
          d="M7.5 13.4l3.6 3.6 7.4-8"
          stroke="var(--brand)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="flex items-baseline gap-1.5 leading-none">
        <span className="figure text-[1.05rem] font-semibold tracking-tight text-foreground">905</span>
        <span className="font-heading text-[1.05rem] font-medium tracking-tight text-ink-soft">
          Finance
        </span>
      </span>
    </span>
  );
  if (href === null) return mark;
  return (
    <Link
      href={href}
      aria-label="905 Finance home"
      className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {mark}
    </Link>
  );
}
