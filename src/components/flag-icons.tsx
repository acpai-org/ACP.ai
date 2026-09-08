import type { ReactNode } from "react";
import type { Language } from "@/lib/i18n/types";

// ─────────────────────────────────────────────────────────────────────────────
// Flag icons (C18): real flag SVGs for the language selector — Windows does
// not render flag emoji (it falls back to letter codes like "JP"), which was
// exactly the Phase-2 bug. Simple, crisp, hand-built 3:2 flags.
// ─────────────────────────────────────────────────────────────────────────────

function FlagSvg({ children, ariaLabel }: { children: ReactNode; ariaLabel: string }) {
  return (
    <svg
      viewBox="0 0 60 40"
      width="1.28em"
      height="0.86em"
      role="img"
      aria-label={ariaLabel}
      className="shrink-0 overflow-hidden rounded-[2px] ring-1 ring-foreground/10"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function UKFlag() {
  return (
    <FlagSvg ariaLabel="English">
      <rect width="60" height="40" fill="#012169" />
      <path d="M0,0 L60,40 M60,0 L0,40" stroke="#ffffff" strokeWidth="8" />
      <path d="M0,0 L60,40 M60,0 L0,40" stroke="#C8102E" strokeWidth="4" />
      <path d="M30,0 V40 M0,20 H60" stroke="#ffffff" strokeWidth="13" />
      <path d="M30,0 V40 M0,20 H60" stroke="#C8102E" strokeWidth="8" />
    </FlagSvg>
  );
}

export function JapanFlag() {
  return (
    <FlagSvg ariaLabel="日本語">
      <rect width="60" height="40" fill="#ffffff" />
      <circle cx="30" cy="20" r="11" fill="#BC002D" />
    </FlagSvg>
  );
}

export function KoreaFlag() {
  return (
    <FlagSvg ariaLabel="한국어">
      <rect width="60" height="40" fill="#ffffff" />
      {/* Taegeuk: a proper S-split yin-yang. The two closed paths share the
          SAME S boundary (big top arc + right-dip + left-dome for red; big
          bottom arc + the same S retraced for blue) — complementary, never
          overlapping, no unpainted gaps. (The old pair anchored both halves
          on the right semicircle: blue overpainted red and left the left
          side white.) */}
      <path
        d="M21 20 A9 9 0 0 1 39 20 A4.5 4.5 0 0 1 30 20 A4.5 4.5 0 0 0 21 20 Z"
        fill="#CD2E3A"
      />
      <path
        d="M21 20 A9 9 0 0 0 39 20 A4.5 4.5 0 0 1 30 20 A4.5 4.5 0 0 0 21 20 Z"
        fill="#0047A0"
      />
      {/* Trigrams: black, with the BROKEN yin lines drawn as two segments —
          Geon ☰ (3 solid, upper-left), Ri ☲ (outer solid, middle broken,
          upper-right), Gam ☵ (outer broken, middle solid, lower-left),
          Gon ☷ (3 broken, lower-right). */}
      <g stroke="#000000" strokeWidth="1.7" strokeLinecap="round">
        {/* Geon ☰ — upper-left */}
        <path d="M8 7.5h8M8 11h8M8 14.5h8" />
        {/* Ri ☲ — upper-right (solid, broken, solid) */}
        <path d="M44 7.5h8M44 11h3.4M48.6 11h3.4M44 14.5h8" />
        {/* Gam ☵ — lower-left (broken, solid, broken) */}
        <path d="M8 25.5h3.4M12.6 25.5h3.4M8 29h8M8 32.5h3.4M12.6 32.5h3.4" />
        {/* Gon ☷ — lower-right (3 broken) */}
        <path d="M44 25.5h3.4M48.6 25.5h3.4M44 29h3.4M48.6 29h3.4M44 32.5h3.4M48.6 32.5h3.4" />
      </g>
    </FlagSvg>
  );
}

export function ChinaFlag() {
  return (
    <FlagSvg ariaLabel="中文">
      <rect width="60" height="40" fill="#EE1C25" />
      {/* Large star */}
      <path
        d="M10 7l1.8 5.5 5.8.2-4.6 3.6 1.6 5.6L10 18.8 5.4 21.9l1.6-5.6L2.4 12.7l5.8-.2z"
        fill="#FFDE00"
      />
      {/* Small stars */}
      {[
        { x: 20, y: 4, s: 0.42, r: 20 },
        { x: 24, y: 8, s: 0.42, r: 40 },
        { x: 24, y: 13, s: 0.42, r: 60 },
        { x: 20, y: 16, s: 0.42, r: 80 },
      ].map((st, i) => (
        <g key={i} transform={`translate(${st.x},${st.y}) rotate(${st.r}) scale(${st.s})`}>
          <path
            d="M0-4.2l1.1 3.4 3.6.1-2.9 2.2 1.1 3.4L0 3.1l-2.9 2.2 1.1-3.4-2.9-2.2 3.6-.1z"
            fill="#FFDE00"
          />
        </g>
      ))}
    </FlagSvg>
  );
}

export function FlagForLanguage({ code }: { code: Language }) {
  switch (code) {
    case "en":
      return <UKFlag />;
    case "ja":
      return <JapanFlag />;
    case "ko":
      return <KoreaFlag />;
    case "zh":
      return <ChinaFlag />;
  }
}
