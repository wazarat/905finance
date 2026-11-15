import type { FindingCode } from "@/db/schema";
import { cn } from "@/lib/utils";

/**
 * The source lines a finding points at, as the testing worker read them from
 * the project, with the reported lines marked. Plain text: nothing here is
 * interpreted.
 */
export function CodeExcerpt({ code, tone = "warn" }: { code: FindingCode; tone?: "warn" | "danger" }) {
  const mark = tone === "danger" ? "bg-destructive/15" : "bg-warn-dim";
  const edge = tone === "danger" ? "border-destructive" : "border-warn";
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-background/60">
      <figcaption className="figure border-b border-border px-3 py-1.5 text-xs break-all text-muted-foreground">
        {code.file}
      </figcaption>
      <div className="overflow-x-auto">
        <table className="figure w-full border-collapse text-xs leading-relaxed">
          <tbody>
            {code.lines.map((line, index) => {
              const number = code.startLine + index;
              const reported = number >= code.highlightStart && number <= code.highlightEnd;
              return (
                <tr key={number} className={reported ? mark : undefined}>
                  <td
                    className={cn(
                      "w-px border-l-2 py-0.5 pr-3 pl-3 text-right tabular-nums select-none",
                      reported ? cn(edge, "text-foreground") : "border-transparent text-muted-foreground",
                    )}
                  >
                    {number}
                  </td>
                  <td className={cn("py-0.5 pr-4 whitespace-pre", reported ? "text-foreground" : "text-ink-soft")}>
                    {line || " "}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
