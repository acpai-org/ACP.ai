import { cn } from "@/lib/utils";

/**
 * RouteSkeleton — loading placeholder shown while client-only route chunks
 * (chat / wallet / recurring views and the Web3 provider) stream in.
 *
 * Mirrors the PageContainer layout (max-w-4xl column, icon + title header,
 * glass panel rows) so the swap from skeleton → real content does not jump.
 * Uses the global `.shimmer` sweep — no JS, no layout shift:
 * every block has fixed dimensions identical to its live counterpart.
 */
export function RouteSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-full overflow-y-auto pt-[84px] sm:pt-[92px]",
        className,
      )}
      aria-busy="true"
      aria-live="polite"
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        {/* header: icon square + title + description */}
        <div className="mb-6 flex items-start gap-3">
          <div className="shimmer h-10 w-10 shrink-0 rounded-xl" />
          <div className="space-y-2 pt-0.5">
            <div className="shimmer h-6 w-44 rounded-lg" />
            <div className="shimmer h-3.5 w-64 rounded-md" />
          </div>
        </div>

        {/* stat row */}
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="shimmer h-20 rounded-2xl border border-border" />
          <div className="shimmer h-20 rounded-2xl border border-border" />
          <div className="shimmer hidden h-20 rounded-2xl border border-border sm:block" />
        </div>

        {/* glass panel rows */}
        <div className="glass-panel space-y-3 p-5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/40 px-4 py-3.5"
            >
              <div className="shimmer h-9 w-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="shimmer h-3.5 w-1/3 rounded-md" />
                <div className="shimmer h-3 w-1/2 rounded-md" />
              </div>
              <div className="shimmer h-6 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
