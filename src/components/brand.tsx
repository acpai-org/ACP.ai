import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Brand imagery — exclusively the owner-provided logo assets (N16).
// The owner's 2025-09 uploads (for-light-mode.png 1024×290, for-dark-mode.png
// 1024×307) carry ~7% horizontal padding around the glyph, so they are tight-
// cropped (glyph + 12px breathing margin, extracted with sharp, bounds
// measured from the alpha channel — scripts/logo-crop.mjs pattern) so the
// wordmark fills its box edge-to-edge: mark-light 895×274, mark-dark 888×272.
//
// Sizing contract (U1): BrandMark takes its HEIGHT from `className`
// (h-10, h-12, …); the width follows the image's intrinsic ~3.26:1 aspect.
//
// Both variants are shown/hidden via the `dark:` variant on <html>, so the
// mark is correct in every theme with zero client JS and zero SSR flash:
// for-light-mode → mark-light.png (light theme), for-dark-mode →
// mark-dark.png (dark theme), exactly as the owner named the files.
// ─────────────────────────────────────────────────────────────────────────────

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex shrink-0 items-center", className)} aria-hidden="true">
      {/* Light theme: the for-light-mode mark. Dark theme: the for-dark-mode mark. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/mark-light.png"
        alt=""
        width={895}
        height={274}
        className="block h-full w-auto object-contain dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/mark-dark.png"
        alt=""
        width={888}
        height={272}
        className="hidden h-full w-auto object-contain dark:block"
      />
    </span>
  );
}

/**
 * Full lockup. The tight mark IS the full "ACP.ai" wordmark (the owner's
 * glyph is a horizontal lockup), so this is the mark alone — kept for the
 * surfaces that historically asked for "mark + name".
 */
export function BrandLogo({ className }: { className?: string }) {
  return <BrandMark className={cn("h-9", className)} />;
}

/** P1: the navbar lockup — mark ONLY (the owner removed the separate
 *  wordmark text from the navbar; the mark itself carries the name). */
export function BrandMarkOnly({ className }: { className?: string }) {
  return <BrandMark className={cn("h-10", className)} />;
}
