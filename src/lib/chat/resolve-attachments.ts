"use client";

import { useI18n } from "@/lib/i18n";
import { CHAIN_REGISTRY, getChainByChainId } from "@/lib/chains/registry";
import type { SlashCommandId } from "@/lib/chat/slash-commands";

// ─────────────────────────────────────────────────────────────────────────────
// Attachment resolution (C23) — resolves a pinned context attachment into a
// plain-text block that is appended to the outgoing prompt. Data is fetched
// FRESH at send time (never cached in the transcript), failures are honest
// ("unavailable: reason"), and everything is read-only — the fixed toolset
// and wallet-signature gating remain the only paths that move anything.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttachmentWalletContext {
  connected: boolean;
  address: string | null;
  chainId: number | null;
  /** Formatted native balance, e.g. "0.0421" (null when unavailable). */
  nativeBalance: string | null;
  nativeSymbol: string | null;
  /** Live discovered tokens on the active chain. */
  tokens: Array<{ symbol: string; balance: string; address: string | null }>;
}

function t(key: string, params?: Record<string, string | number>): string {
  // The i18n store is a zustand singleton — safe to read from async code.
  const store = useI18n.getState();
  return store.t(key as Parameters<typeof store.t>[0], params);
}

async function fetchJson(url: string, timeoutMs = 6000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function header(id: SlashCommandId): string {
  return `[${t("chat.ctx.attachedHeader")} — ${t(`chat.ctx.${id}.label`)}]`;
}

function resolveBalance(ctx: AttachmentWalletContext): string {
  const lines: string[] = [];
  if (!ctx.connected || !ctx.address) {
    lines.push(t("chat.ctx.balance.notConnected"));
  } else {
    const chain = ctx.chainId != null ? getChainByChainId(ctx.chainId) : undefined;
    lines.push(`${t("chat.ctx.balance.wallet")}: ${ctx.address}`);
    lines.push(`${t("chat.ctx.balance.chain")}: ${chain?.name ?? ctx.chainId ?? "?"}`);
    if (ctx.nativeBalance != null) {
      lines.push(`${ctx.nativeSymbol ?? "ETH"}: ${ctx.nativeBalance}`);
    }
    const withUsd = ctx.tokens.filter((tk) => tk.balance !== "0");
    if (withUsd.length === 0) {
      lines.push(t("chat.ctx.balance.noTokens"));
    } else {
      for (const tk of withUsd.slice(0, 25)) {
        lines.push(`${tk.symbol}: ${tk.balance}${tk.address ? ` (${tk.address})` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

function resolveChain(ctx: AttachmentWalletContext): string {
  const lines: string[] = [];
  const active = ctx.chainId != null ? getChainByChainId(ctx.chainId) : undefined;
  if (ctx.connected && active) {
    lines.push(`${t("chat.ctx.chain.active")}: ${active.name} (chainId ${active.chainId}${active.testnet ? ", testnet" : ""})`);
  } else {
    lines.push(t("chat.ctx.chain.disconnected"));
  }
  lines.push(`${t("chat.ctx.chain.supported")}:`);
  for (const c of CHAIN_REGISTRY) {
    lines.push(`- ${c.name} (chainId ${c.chainId}${c.testnet ? ", testnet" : ""})`);
  }
  return lines.join("\n");
}

interface ContactRow {
  label: string;
  address: string;
  favorite?: boolean;
}

async function resolveContacts(): Promise<string> {
  const json = (await fetchJson("/api/contacts")) as { contacts?: ContactRow[] };
  const rows = json.contacts ?? [];
  if (rows.length === 0) return t("chat.ctx.contacts.empty");
  return rows
    .slice(0, 40)
    .map((c) => `- ${c.label}: ${c.address}${c.favorite ? " ★" : ""}`)
    .join("\n");
}

interface ActionRow {
  tool: string;
  status: string;
  summary: string | null;
  chainId: number | null;
  createdAt: string | number;
}

async function resolveActions(): Promise<string> {
  const json = (await fetchJson("/api/agent/actions?limit=10")) as { actions?: ActionRow[] };
  const rows = json.actions ?? [];
  if (rows.length === 0) return t("chat.ctx.actions.empty");
  return rows
    .map((a) => {
      const when = new Date(a.createdAt).toLocaleString();
      const chain = a.chainId != null ? ` [${getChainByChainId(a.chainId)?.shortName ?? a.chainId}]` : "";
      return `- ${when}${chain} ${a.tool} → ${a.status}: ${a.summary ?? ""}`.trimEnd();
    })
    .join("\n");
}

interface AttestcoinStatus {
  sourceHeight?: number;
  destinationHeight?: number;
  lagBlocks?: number;
  network?: string;
  attestations?: number;
}

async function resolveAttestcoin(): Promise<string> {
  const json = (await fetchJson("/api/attestcoin/status")) as AttestcoinStatus & { error?: string };
  if (json && typeof json === "object" && "error" in json && json.error) {
    return `${t("chat.ctx.attestcoin.unavailable")}: ${json.error}`;
  }
  const lines = [
    `${t("chat.ctx.attestcoin.network")}: ${json.network ?? "testnet"}`,
    `${t("chat.ctx.attestcoin.sourceHeight")}: ${json.sourceHeight ?? "?"}`,
    `${t("chat.ctx.attestcoin.destinationHeight")}: ${json.destinationHeight ?? "?"}`,
    `${t("chat.ctx.attestcoin.lag")}: ${json.lagBlocks ?? "?"} blocks`,
  ];
  return lines.join("\n");
}

interface ScheduleRow {
  id: string;
  recipient: string;
  token: string;
  amount: string;
  cadence: string;
  active: boolean;
  nextFireAt?: string | number | null;
}

async function resolveSchedule(): Promise<string> {
  const json = (await fetchJson("/api/recurring")) as { schedules?: ScheduleRow[] };
  const rows = (json.schedules ?? []).slice(0, 30);
  if (rows.length === 0) return t("chat.ctx.schedule.empty");
  return rows
    .map((s) => {
      // nextFireAt is epoch SECONDS (the fire-loop contract) — Date() expects ms.
      const next = s.nextFireAt ? new Date(Number(s.nextFireAt) * 1000).toLocaleString() : "—";
      return `- ${s.amount} ${s.token} → ${s.recipient} (${s.cadence}), ${s.active ? "active" : "paused"}, next: ${next}`;
    })
    .join("\n");
}

/** Resolve one attachment id into its labeled text block. */
export async function resolveAttachment(
  id: SlashCommandId,
  ctx: AttachmentWalletContext,
): Promise<string> {
  let body: string;
  try {
    switch (id) {
      case "balance":
        body = resolveBalance(ctx);
        break;
      case "chain":
        body = resolveChain(ctx);
        break;
      case "contacts":
        body = await resolveContacts();
        break;
      case "actions":
        body = await resolveActions();
        break;
      case "attestcoin":
        body = await resolveAttestcoin();
        break;
      case "schedule":
        body = await resolveSchedule();
        break;
    }
  } catch (err) {
    body = `${t("chat.ctx.unavailable")}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `${header(id)}\n${body}`;
}

/** Expand every attachment into one combined context block. */
export async function resolveAttachments(
  ids: string[],
  ctx: AttachmentWalletContext,
): Promise<string> {
  const parts = await Promise.all(
    ids.map((id) => resolveAttachment(id as SlashCommandId, ctx)),
  );
  return parts.join("\n\n");
}
