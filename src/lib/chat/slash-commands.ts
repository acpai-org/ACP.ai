"use client";

import {
  Wallet,
  Globe,
  Users,
  History,
  ShieldCheck,
  CalendarClock,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "@/lib/i18n/types";

// ─────────────────────────────────────────────────────────────────────────────
// Slash command registry (C23) — the "/" command menu in the chat composer.
// Each command pins a CONTEXT ATTACHMENT to the outgoing message; the data is
// resolved fresh at send time (never cached in the transcript) and expanded
// into the prompt as a labeled context block. Text-only by design — image
// attachments are explicitly out of scope (§ hard boundary).
// ─────────────────────────────────────────────────────────────────────────────

export type SlashCommandId = "balance" | "chain" | "contacts" | "actions" | "attestcoin" | "schedule";

export interface SlashCommandDef {
  id: SlashCommandId;
  /** i18n key for the visible label */
  titleKey: TranslationKey;
  /** i18n key for the one-line description shown in the menu */
  descKey: TranslationKey;
  icon: LucideIcon;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    id: "balance",
    titleKey: "chat.ctx.balance.label",
    descKey: "chat.ctx.balance.desc",
    icon: Wallet,
  },
  {
    id: "chain",
    titleKey: "chat.ctx.chain.label",
    descKey: "chat.ctx.chain.desc",
    icon: Globe,
  },
  {
    id: "contacts",
    titleKey: "chat.ctx.contacts.label",
    descKey: "chat.ctx.contacts.desc",
    icon: Users,
  },
  {
    id: "actions",
    titleKey: "chat.ctx.actions.label",
    descKey: "chat.ctx.actions.desc",
    icon: History,
  },
  {
    id: "attestcoin",
    titleKey: "chat.ctx.attestcoin.label",
    descKey: "chat.ctx.attestcoin.desc",
    icon: ShieldCheck,
  },
  {
    id: "schedule",
    titleKey: "chat.ctx.schedule.label",
    descKey: "chat.ctx.schedule.desc",
    icon: CalendarClock,
  },
];

/** Filter commands by the (partial) word typed after "/". */
export function filterSlashCommands(query: string): SlashCommandDef[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.id.startsWith(q));
}
