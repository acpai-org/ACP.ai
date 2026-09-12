import type { KeyboardEvent } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Roving-tabindex keyboard navigation for filter chip rows (R28 actions view,
// R30 payments view). ArrowLeft/Right (and Up/Down) cycle through the chips,
// Home/End jump to the ends. Selection stays activate-on-Enter/Space (native
// button semantics); arrows move FOCUS only — the standard toolbar pattern.
// ─────────────────────────────────────────────────────────────────────────────

export function rovingKeydown(
  e: KeyboardEvent<HTMLButtonElement>,
  idx: number,
  count: number,
  refs: { current: (HTMLButtonElement | null)[] },
): void {
  let next: number | null = null;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % count;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + count) % count;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = count - 1;
  if (next !== null) {
    e.preventDefault();
    refs.current[next]?.focus();
  }
}
