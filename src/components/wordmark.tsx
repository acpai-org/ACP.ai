import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-mono font-bold tracking-tight text-effect select-none",
        className,
      )}
    >
      ACP.ai
    </span>
  );
}
