"use client";

import type { SlashCommandId } from "@/lib/chat/slash-commands";

// ─────────────────────────────────────────────────────────────────────────────
// @-mention contact autocomplete (R7).
//
// Typing "@" followed by letters in the composer opens a contact picker; the
// selected contact is inserted inline as `Label (0xAddress) ` — the exact
// recipient text the agent's transfer tool needs, so a payment request can be
// written as "send @alice 5 USDC" without ever typing an address.
//
// Contacts are read-only reference data, so a short module-level cache fronts
// the fetch (the menu reopens repeatedly within one typing burst). Failures
// degrade to an empty list — the menu shows its empty state, never an error.
// ─────────────────────────────────────────────────────────────────────────────

export interface MentionCandidate {
  id: string;
  label: string;
  address: string;
  favorite: boolean;
}

const CACHE_TTL_MS = 30_000;

let cache: { at: number; contacts: MentionCandidate[] } | null = null;
let inflight: Promise<MentionCandidate[]> | null = null;

/** Fetch contacts for the mention menu (cached, failure-safe). */
export async function fetchMentionCandidates(): Promise<MentionCandidate[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.contacts;
  if (inflight) return inflight;
  inflight = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch("/api/contacts", { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        contacts?: Array<{ id?: unknown; label?: unknown; address?: unknown; favorite?: unknown }>;
      };
      const contacts: MentionCandidate[] = [];
      for (const c of data.contacts ?? []) {
        // Strict shape check — a corrupt row must never reach the picker.
        if (typeof c.id !== "string" || typeof c.label !== "string" || typeof c.address !== "string") continue;
        contacts.push({ id: c.id, label: c.label, address: c.address, favorite: c.favorite === true });
      }
      cache = { at: Date.now(), contacts };
      return contacts;
    } catch {
      return []; // network/parse failure — menu shows the empty state
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

/** Drop the cache (used by QA + after contact mutations from this tab). */
export function invalidateMentionCache(): void {
  cache = null;
}

// ── Cache invalidation on contact mutations (R7 open item (a)) ──────────────
// The contacts page and the chat are separate routes in one SPA — a contact
// added/edited/deleted there must reach an ALREADY-OPEN mention menu without
// waiting out the TTL. The api layer dispatches this event from every contact
// mutation's success path; the module listener drops the cache so the next
// menu open refetches.
const CONTACTS_CHANGED_EVENT = "acp:contacts-changed";

if (typeof window !== "undefined") {
  window.addEventListener(CONTACTS_CHANGED_EVENT, () => {
    cache = null;
  });
}

/** Notify the mention cache that the contact list changed (same tab). */
export function notifyContactsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONTACTS_CHANGED_EVENT));
}

/** Filter candidates by the typed query (label or address substring).
 *  The address matches AFTER its 0x prefix — otherwise a bare "x" or "0"
 *  query would match every contact via the literal "0x". */
export function filterMentionCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, 8);
  const bare = q.startsWith("0x") ? q.slice(2) : q;
  return candidates
    .filter((c) => c.label.toLowerCase().includes(q) || (bare.length > 0 && c.address.toLowerCase().slice(2).includes(bare)))
    .slice(0, 8);
}

/**
 * The mention token is the trailing "@word" (or a bare "@") at the END of the
 * composer value, anchored to the message start or whitespace — a mid-word
 * "@" (e.g. an email address being typed) must never open the picker. The
 * composer only consults this while the caret sits at the end of the value;
 * returns null when no active token.
 */
const MENTION_TYPING_RE = /(?:^|\s)@([a-zA-Z0-9]*)$/;

export function activeMentionQuery(value: string): string | null {
  const m = MENTION_TYPING_RE.exec(value);
  return m ? m[1].toLowerCase() : null;
}

/** Replace the trailing @token with the committed mention text. */
export function applyMention(value: string, label: string, address: string): string {
  const m = MENTION_TYPING_RE.exec(value);
  if (!m) return value;
  const head = value.slice(0, value.length - m[0].length);
  // The inserted text starts with a space when the token was mid-message
  // (the anchor whitespace belongs to the token, not the insertion).
  const lead = m[0].startsWith("@") ? "" : " ";
  return `${head}${lead}${label} (${address}) `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft persistence (R6/R7) — the composer draft now carries BOTH the typed
// text AND the pinned slash-command attachments, so a reload or a session
// switch restores the exact pending state. Old string-only entries migrate
// on load (attachments: []).
// ─────────────────────────────────────────────────────────────────────────────

export interface ComposerDraft {
  text: string;
  attachments: SlashCommandId[];
}

export function isComposerDraft(v: unknown): v is ComposerDraft {
  if (typeof v !== "object" || v === null) return false;
  const d = v as { text?: unknown; attachments?: unknown };
  if (typeof d.text !== "string") return false;
  if (d.attachments !== undefined && !Array.isArray(d.attachments)) return false;
  return true;
}
