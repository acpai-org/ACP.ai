// ─────────────────────────────────────────────────────────────────────────────
// Cadence spec (C37 + P17 — fully-custom recurring schedules, down to seconds).
//
// A single source of truth for how recurrence is expressed, stored, parsed and
// validated — shared by the fire executor (server), the register form (client),
// the agent tool (server) and the label renderer (client). No node-only
// imports: this module is client-safe.
//
// STORED FORMAT (the DB `cadence` text column, backwards compatible):
//   • presets:  "daily" | "weekly" | "biweekly" | "monthly"
//   • custom:   "every-<n>s" (seconds, 10–86400) | "every-<n>m" (minutes, 1–1440)
//              | "every-<n>h" (hours, 1–2160) | "every-<n>d" (days, 1–365)
//   • legacy:   "1"|"2"|"3" (weekly/biweekly/monthly — Phase-1 form dialect)
//               and any other positive numeric string N (defensive N-day
//               branch, now formalized as custom days instead of a surprise)
//
// The interval math ALWAYS resolves through parseCadence — no call site is
// allowed to hand-roll its own cadence → milliseconds mapping.
// ─────────────────────────────────────────────────────────────────────────────

export type CadenceUnit = "seconds" | "minutes" | "hours" | "days";
export type CadencePreset = "daily" | "weekly" | "biweekly" | "monthly";

export type CadenceSpec =
  | { kind: "preset"; preset: CadencePreset; intervalMs: number }
  | { kind: "custom"; unit: CadenceUnit; n: number; intervalMs: number };

const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/** Protocol bounds — enforced on every write path (form, agent tool, API).
 * P17: seconds-level scheduling is supported; the 10-second floor is a
 * sanity guard (real funds move on each fire — sub-10s schedules would spam
 * wallet prompts). Logged decision, correctable by the owner in one line. */
export const CADENCE_BOUNDS = {
  minSeconds: 10,
  maxSeconds: 86_400, // 1 day — longer intervals use hours/days
  minMinutes: 1,
  maxMinutes: 1_440,
  minHours: 1,
  maxHours: 2160, // 90 days — the longest sub-daily schedule worth expressing
  minDays: 1,
  maxDays: 365,
} as const;

export const CADENCE_UNITS: ReadonlyArray<CadenceUnit> = ["seconds", "minutes", "hours", "days"] as const;

export function cadenceUnitBounds(unit: CadenceUnit): { min: number; max: number; ms: number } {
  switch (unit) {
    case "seconds":
      return { min: CADENCE_BOUNDS.minSeconds, max: CADENCE_BOUNDS.maxSeconds, ms: SECOND_MS };
    case "minutes":
      return { min: CADENCE_BOUNDS.minMinutes, max: CADENCE_BOUNDS.maxMinutes, ms: MINUTE_MS };
    case "hours":
      return { min: CADENCE_BOUNDS.minHours, max: CADENCE_BOUNDS.maxHours, ms: HOUR_MS };
    case "days":
      return { min: CADENCE_BOUNDS.minDays, max: CADENCE_BOUNDS.maxDays, ms: DAY_MS };
  }
}

export const CADENCE_PRESETS: ReadonlyArray<{ preset: CadencePreset; intervalMs: number }> = [
  { preset: "daily", intervalMs: 1 * DAY_MS },
  { preset: "weekly", intervalMs: 7 * DAY_MS },
  { preset: "biweekly", intervalMs: 14 * DAY_MS },
  { preset: "monthly", intervalMs: 30 * DAY_MS },
] as const;

function presetSpec(preset: CadencePreset): CadenceSpec {
  const found = CADENCE_PRESETS.find((p) => p.preset === preset);
  return { kind: "preset", preset, intervalMs: found?.intervalMs ?? 30 * DAY_MS };
}

const PRESET_NAMES: ReadonlySet<string> = new Set(CADENCE_PRESETS.map((p) => p.preset));

/** Parse the storage dialect's unit letter into a CadenceUnit. */
const UNIT_LETTERS: Record<string, CadenceUnit> = { s: "seconds", m: "minutes", h: "hours", d: "days" };

/**
 * Parse ANY stored cadence dialect into a spec. Never throws:
 * unknown/broken values degrade to monthly (the historical fallback), but the
 * custom/legacy dialects are first-class.
 */
export function parseCadence(raw: string | number | null | undefined): CadenceSpec {
  if (raw == null) return presetSpec("monthly");
  const s = String(raw).trim().toLowerCase();

  // Presets (incl. the new "daily").
  if (PRESET_NAMES.has(s)) return presetSpec(s as CadencePreset);

  // Custom storage form: "every-<n>s|m|h|d" (P17 added s + m).
  const custom = s.match(/^every-(\d+)(s|m|h|d)$/);
  if (custom) {
    const unit = UNIT_LETTERS[custom[2]] ?? "days";
    const n = Number(custom[1]);
    const clamped = clampCustom(unit, n);
    return { kind: "custom", unit, n: clamped.n, intervalMs: clamped.intervalMs };
  }

  // Legacy numeric dialect: 1|2|3 = weekly|biweekly|monthly; any other
  // positive integer N = every-N-days (the formalized defensive branch).
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) {
    if (n === 1) return presetSpec("weekly");
    if (n === 2) return presetSpec("biweekly");
    if (n === 3) return presetSpec("monthly");
    const clamped = clampCustom("days", Math.floor(n));
    return { kind: "custom", unit: "days", n: clamped.n, intervalMs: clamped.intervalMs };
  }

  return presetSpec("monthly");
}

/** Clamp an (unit, n) pair into bounds; out-of-range values pull IN. */
export function clampCustom(unit: CadenceUnit, n: number): { n: number; intervalMs: number } {
  const { min, max, ms } = cadenceUnitBounds(unit);
  const bounded = Math.min(max, Math.max(min, Math.floor(n) || min));
  return { n: bounded, intervalMs: bounded * ms };
}

/** Validate an intended custom cadence BEFORE storing (honest error strings). */
export function validateCustomCadence(unit: CadenceUnit, n: number): { ok: true; n: number } | { ok: false; error: string } {
  const { min, max } = cadenceUnitBounds(unit);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    return { ok: false, error: `interval must be an integer between ${min} and ${max} ${unit}` };
  }
  return { ok: true, n };
}

/** Canonical STORAGE string for a spec (what the DB column and API carry). */
export function cadenceStorage(spec: CadenceSpec): string {
  if (spec.kind === "preset") return spec.preset;
  const letter = spec.unit === "seconds" ? "s" : spec.unit === "minutes" ? "m" : spec.unit === "hours" ? "h" : "d";
  return `every-${spec.n}${letter}`;
}

/** Interval in milliseconds — the ONLY sanctioned cadence → duration mapping. */
export function cadenceIntervalMs(raw: string | number | null | undefined): number {
  return parseCadence(raw).intervalMs;
}

/**
 * Label parts for i18n rendering — the view turns these into localized text
 * ("Every 10 days", “每6小时”, …). Presets carry their key; customs carry
 * unit + count.
 */
export function cadenceLabelParts(raw: string | number | null | undefined):
  | { kind: "preset"; preset: CadencePreset }
  | { kind: "custom"; unit: CadenceUnit; n: number } {
  const spec = parseCadence(raw);
  if (spec.kind === "preset") return { kind: "preset", preset: spec.preset };
  return { kind: "custom", unit: spec.unit, n: spec.n };
}

/** English fallback label (agent summaries, server-side strings). */
export function cadenceLabelEn(raw: string | number | null | undefined): string {
  const spec = parseCadence(raw);
  if (spec.kind === "preset") return spec.preset;
  const plural = spec.n === 1 ? "" : "s";
  return `every ${spec.n} ${spec.unit.slice(0, -1)}${plural}`;
}

/** Humanized wait rendering for server summaries (seconds-aware, P17). */
export function formatIntervalHuman(ms: number): string {
  if (ms < 90_000) return `~${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `~${Math.round(ms / 60_000)}m`;
  if (ms < 48 * 3_600_000) return `~${Math.round(ms / 3_600_000)}h`;
  return `~${Math.round(ms / 86_400_000)}d`;
}

/**
 * Is this a RECOGNIZED cadence storage value? (presets, in-bounds customs,
 * legacy numeric dialect). The API uses this to reject garbage honestly
 * (400) instead of letting it silently degrade to monthly.
 */
export function isKnownCadenceSpec(raw: string | number | null | undefined): boolean {
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase();
  if (PRESET_NAMES.has(s)) return true;
  const custom = s.match(/^every-(\d+)(s|m|h|d)$/);
  if (custom) {
    const unit = UNIT_LETTERS[custom[2]] ?? "days";
    const { min, max } = cadenceUnitBounds(unit);
    const n = Number(custom[1]);
    return Number.isInteger(n) && n >= min && n <= max;
  }
  // Legacy numeric dialect: any positive integer (days).
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n <= CADENCE_BOUNDS.maxDays;
}
