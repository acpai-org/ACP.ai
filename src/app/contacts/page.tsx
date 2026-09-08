"use client";

import { useMemo, useState, useCallback, memo, useDeferredValue, startTransition, useEffect } from "react";
import {
  Users,
  Star,
  Plus,
  Send,
  Trash2,
  Loader2,
  X,
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  ChevronDown,
  Sparkles,
  UserPlus,
  Pencil,
  QrCode,
  Repeat,
} from "lucide-react";
import Link from "next/link";
import { isAddress, getAddress } from "viem";
import { useChainId } from "wagmi";
import { PageContainer } from "@/components/page-container";
import { Card, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FinderSearch } from "@/components/finder-search";
import {
  useContacts,
  useCreateContact,
  useDeleteContact,
  useUpdateContact,
  usePayments,
  type Contact,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useAskAgent } from "@/lib/use-ask-agent";
import { getChainByChainId } from "@/lib/chains/registry";
import { payeeKey, rollupsByPayee, rollupStatusTone, type ContactRollup, type RollupPayment } from "@/lib/contacts/rollup";
import { networkName } from "@/lib/wagmi/chains";
import { ContactQrModal } from "@/components/contacts/contact-qr-modal";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Contacts (C9 revision): the address book as a first-class surface —
// neumorphic finder search (C17), deterministic per-address avatars, favorites
// pinned first, in-place expandable detail (full address + copy + explorer,
// note, last use), agent hand-off quick actions (pay this contact), two-tap
// delete confirmation, live-validated add form with duplicate detection.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const LOAD_TIME = Date.now();

/** Deterministic hue from the address — stable avatars across sessions. */
function addressHue(address: string): number {
  const slice = address.slice(2, 10);
  let hash = 0;
  for (let i = 0; i < slice.length; i += 2) {
    hash = (hash * 31 + parseInt(slice.slice(i, i + 2), 16)) % 360;
  }
  return hash;
}

function AvatarTile({ label, address, size = "md" }: { label: string; address: string; size?: "md" | "lg" }) {
  const hue = addressHue(address);
  const initials = label
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const dim = size === "lg" ? "h-12 w-12 text-base" : "h-11 w-11 text-sm";
  return (
    <span
      aria-hidden
      className={cn(dim, "flex shrink-0 items-center justify-center rounded-full font-semibold transition-transform duration-200 group-hover:scale-[1.04]")}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 70% 55% / 0.22), hsl(${(hue + 40) % 360} 70% 55% / 0.08))`,
        color: `hsl(${hue} 75% 60%)`,
        boxShadow: `inset 0 0 0 1px hsl(${hue} 70% 55% / 0.28), 0 4px 12px -6px hsl(${hue} 70% 55% / 0.35)`,
      }}
    >
      {initials}
    </span>
  );
}

// AddressBook is not exported by lucide-react@1.x — inline equivalent.
function AddressBookIcon() {
  return <UserPlus className="h-4 w-4 text-primary" aria-hidden />;
}

/** Checksum-display helper: a malformed stored address must never crash the
 * card render (defensive — the add form + server both validate on write). */
function safeChecksumAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

const TONE_DOT: Record<ReturnType<typeof rollupStatusTone>, string> = {
  success: "bg-success shadow-[0_0_6px_rgba(74,222,128,0.55)]",
  warning: "bg-warning shadow-[0_0_6px_rgba(234,179,8,0.5)]",
  danger: "bg-danger shadow-[0_0_6px_rgba(248,113,113,0.5)]",
  primary: "bg-primary shadow-[0_0_6px_rgba(8,145,178,0.5)]",
  muted: "bg-muted-3",
};

/** One compact payment line inside the contact's expanded rollup. */
function RollupRow({ payment }: { payment: RollupPayment }) {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const tone = rollupStatusTone(payment.status);
  return (
    <li className="group/row flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-surface-2/60">
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
      {/* Fixed-width amount column — rows scan as a table: the status/time
          text starts at the same x on every line regardless of digits. */}
      <span className="w-16 shrink-0 text-xs font-medium tabular-nums text-foreground/85">
        {payment.amountHuman} <span className="text-muted-2">{payment.token}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-3" title={payment.memo ?? undefined}>
        {payment.status === "settled" ? t("payments.settled")
          : payment.status === "failed" ? t("payments.failed")
          : t("payments.pending")}
        <span className="mx-1" aria-hidden>·</span>
        {timeAgo(payment.createdAt)}
      </span>
      <button
        type="button"
        onClick={() =>
          askAgent(
            t("payments.payAgainPrompt", {
              amount: payment.amountHuman,
              token: payment.token,
              name: payment.recipientLabel ?? payment.recipientAddress.slice(0, 6) + "…" + payment.recipientAddress.slice(-4),
              address: payment.recipientAddress,
              chain: networkName(payment.chainId),
            }),
          )
        }
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-3 opacity-100 sm:opacity-0 transition-all hover:bg-primary/10 hover:text-primary cursor-pointer sm:group-hover/row:opacity-100 focus-visible:opacity-100"
        aria-label={t("payments.payAgain")}
        title={t("payments.payAgain")}
      >
        <Repeat className="h-3 w-3" />
      </button>
    </li>
  );
}

const ContactCard = memo(function ContactCard({
  contact,
  explorerBase,
  chainId,
  rollup,
}: {
  contact: Contact;
  explorerBase: string | null;
  chainId: number;
  rollup?: ContactRollup;
}) {
  const { t } = useI18n();
  const askAgent = useAskAgent();
  const updateContact = useUpdateContact();
  const deleteContact = useDeleteContact();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // R4 QR sharing modal — renders via portal at the document body.
  const [qrOpen, setQrOpen] = useState(false);
  // C9 edit mode: label + note PATCH inline (address is immutable — payments
  // reference it; re-pointing a contact is a new contact by design).
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editNote, setEditNote] = useState("");

  const startEdit = () => {
    setEditLabel(contact.label);
    setEditNote(contact.note ?? "");
    setEditing(true);
    setExpanded(true);
  };

  const saveEdit = () => {
    const label = editLabel.trim();
    if (!label) return;
    updateContact.mutate(
      { id: contact.id, label, note: editNote.trim() },
      { onSuccess: () => setEditing(false) },
    );
  };

  const explorerUrl = explorerBase ? `${explorerBase}/address/${contact.address}` : null;

  const copyAddress = () => {
    navigator.clipboard?.writeText(contact.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const payContact = () => {
    askAgent(
      t("contacts.sendPrompt", {
        name: contact.label,
        address: contact.address,
      }),
    );
  };

  const repeatLast = () => {
    const last = rollup?.last;
    if (!last) return;
    askAgent(
      t("payments.payAgainPrompt", {
        amount: last.amountHuman,
        token: last.token,
        name: contact.label,
        address: contact.address,
        chain: networkName(last.chainId),
      }),
    );
  };

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 transition-all duration-200 hover:border-primary/30 hover:shadow-[0_12px_28px_-16px_rgba(0,0,0,0.45)]",
        expanded && "border-primary/35 bg-surface/80 shadow-[0_12px_28px_-16px_rgba(0,0,0,0.4)]",
      )}
    >
      {/* Hover accent bar — a 2px primary gradient along the left edge that
          fades in with the card hover; expanded keeps it pinned. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 top-1/2 h-10 w-[2px] -translate-y-1/2 rounded-r-full bg-gradient-to-b from-primary/70 to-primary/20 opacity-0 transition-opacity duration-200 group-hover:opacity-100",
          expanded && "opacity-100",
        )}
      />
      <div className="flex items-start gap-3">
        <AvatarTile label={contact.label} address={contact.address} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
            {contact.label}
            <ChevronDown
              className={cn("h-3 w-3 shrink-0 text-muted-3 transition-transform", expanded && "rotate-180")}
              aria-hidden
            />
          </p>
          <p className="truncate font-mono text-xs text-muted">
            {contact.address.slice(0, 10)}…{contact.address.slice(-8)}
          </p>
        </div>
        <button
          type="button"
          onClick={startEdit}
          disabled={updateContact.isPending}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-3 transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
          aria-label={t("contacts.edit")}
          title={t("contacts.edit")}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => updateContact.mutate({ id: contact.id, favorite: !contact.favorite })}
          disabled={updateContact.isPending}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors cursor-pointer",
            contact.favorite
              ? "bg-warning/15 text-warning"
              : "text-muted-3 hover:bg-surface-2 hover:text-warning",
          )}
          aria-label={contact.favorite ? t("contacts.unfavorite") : t("contacts.favorite")}
          aria-pressed={contact.favorite}
        >
          <Star className={cn("h-3.5 w-3.5", contact.favorite && "fill-current")} />
        </button>
      </div>

      {editing ? (
        <div className="space-y-2 rounded-xl border border-border/70 bg-surface-2/40 p-3">
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-3">
              {t("contacts.editName")}
            </label>
            <input
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              className="neumorphic-field w-full text-sm"
              aria-label={t("contacts.editName")}
              maxLength={64}
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-3">
              {t("contacts.editNote")}
            </label>
            <input
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              className="neumorphic-field w-full text-sm"
              aria-label={t("contacts.editNote")}
              maxLength={200}
            />
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <Button variant="primary" size="sm" onClick={saveEdit} disabled={updateContact.isPending || !editLabel.trim()}>
              {updateContact.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {t("contacts.saveChanges")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t("contacts.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {contact.note ? (
            <p className={cn("text-xs text-muted-2", !expanded && "line-clamp-1")}>{contact.note}</p>
          ) : null}

          {/* Expanded detail (C9): full address + copy + explorer, pay via agent. */}
          {expanded ? (
            <div className="space-y-2.5 rounded-xl border border-border/70 bg-surface-2/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-3">
                  {t("contacts.address")}
                </span>
                <div className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[10px] text-foreground/70" title={contact.address}>
                    {safeChecksumAddress(contact.address)}
                  </span>
                  <button
                    type="button"
                    onClick={copyAddress}
                    aria-label={t("contacts.copyAddress")}
                    className="rounded-md p-1 text-muted-3 transition-colors hover:bg-surface-3 hover:text-foreground cursor-pointer"
                  >
                    {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                  </button>
                  {explorerUrl ? (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-md p-1 text-primary transition-colors hover:bg-primary/10"
                      title={t("trace.explorer")}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-3">
                  {t("contacts.lastUsed")}
                </span>
                <span className="text-[10px] text-foreground/60">
                  {contact.lastUsed > 0 ? timeAgo(contact.lastUsed) : t("contacts.neverUsed")}
                </span>
              </div>
              {rollup && rollup.total > 0 ? (
                <div className="rounded-xl border border-border/60 bg-surface-2/50 p-2.5">
                  <div className="flex items-center justify-between gap-2 pb-1">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-3">
                      {t("contacts.recentPayments")}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-2">
                      {rollup.total === 1
                        ? t("contacts.paymentsCountOne")
                        : t("contacts.paymentsCount", { count: rollup.total })}
                      {rollup.inFlight > 0 ? (
                        <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-px text-[9px] font-medium text-warning">
                          {rollup.inFlight} {t("contacts.inFlightShort")}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {/* R14 (settled totals): per-token sums over settled payments
                      only — never a cross-symbol total (N21/P6 honesty). One
                      quiet success chip per token, capped at 2 with a "+N"
                      overflow hint; hidden entirely when nothing settled. */}
                  {rollup.settledTotals.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
                      {rollup.settledTotals.slice(0, 2).map((st) => (
                        <span
                          key={st.token}
                          className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-px text-[9.5px] font-medium tabular-nums text-success"
                          title={t("contacts.settledTotal", { count: st.count, token: st.token })}
                        >
                          <Check className="h-2.5 w-2.5" aria-hidden />
                          {st.total} {st.token}
                        </span>
                      ))}
                      {rollup.settledTotals.length > 2 ? (
                        <span className="text-[9.5px] tabular-nums text-muted-3">
                          +{rollup.settledTotals.length - 2}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <ul className="space-y-0.5">
                    {rollup.recent.map((p) => (
                      <RollupRow key={p.id} payment={p} />
                    ))}
                  </ul>
                  {/* R17 (WHO lens): deep-link into the payments page filtered
                      to THIS contact — the chip there carries the label + a
                      one-tap clear back to the full list. */}
                  <Link
                    href={`/payments?contact=${encodeURIComponent(contact.address)}`}
                    className="mt-1 flex items-center justify-center gap-1 border-t border-border/50 pt-1.5 text-[10px] font-medium text-primary/80 transition-colors hover:bg-primary/5 hover:text-primary cursor-pointer"
                  >
                    {t("contacts.seeAllPayments")}
                    <ChevronDown className="h-3 w-3 -rotate-90" aria-hidden />
                  </Link>
                </div>
              ) : null}
              <button
                type="button"
                onClick={payContact}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
              >
                <Sparkles className="h-3 w-3" />
                {t("contacts.payViaAgent", { name: contact.label })}
              </button>
            </div>
          ) : null}
        </>
      )}

      <div className="flex items-center justify-between">
        {rollup && rollup.total > 0 && rollup.last ? (
          <button
            type="button"
            onClick={repeatLast}
            className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-2 transition-colors hover:text-primary cursor-pointer"
            title={t("contacts.paymentsSummaryHint")}
          >
            <span
              aria-hidden
              className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[rollupStatusTone(rollup.last.status)])}
            />
            <span className="truncate">
              {rollup.total === 1
                ? t("contacts.rollupOne", { amount: rollup.last.amountHuman, token: rollup.last.token })
                : t("contacts.rollupMany", {
                    count: rollup.total,
                    amount: rollup.last.amountHuman,
                    token: rollup.last.token,
                  })}
              <span className="mx-1 text-muted-3" aria-hidden>·</span>
              {timeAgo(rollup.last.createdAt)}
            </span>
          </button>
        ) : (
          <span className="text-[11px] text-muted-2">
            {contact.lastUsed > 0 ? `${t("contacts.lastUsed")} ${timeAgo(contact.lastUsed)}` : t("contacts.neverUsed")}
          </span>
        )}
        <div className="flex gap-1">
          <button
            type="button"
            onClick={payContact}
            className="flex h-8 items-center gap-1 rounded-lg bg-primary/10 px-2.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
            aria-label={t("contacts.sendTo", { name: contact.label })}
          >
            <Send className="h-3 w-3" />
            <span className="hidden sm:inline">{t("contacts.sendToShort")}</span>
          </button>
          <button
            type="button"
            onClick={() => setQrOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 text-muted-2 transition-colors hover:border-primary/40 hover:text-primary cursor-pointer"
            aria-label={t("contacts.shareQrAction", { name: contact.label })}
            title={t("contacts.shareQrAction", { name: contact.label })}
          >
            <QrCode className="h-3.5 w-3.5" />
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-danger"
                onClick={() => deleteContact.mutate(contact.id, { onSuccess: () => setConfirmDelete(false) })}
                disabled={deleteContact.isPending}
                aria-label={t("contacts.deleteContact")}
              >
                {deleteContact.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="h-8 rounded-lg px-2 text-[10px] font-medium text-muted-2 hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-muted hover:text-danger"
              onClick={() => setConfirmDelete(true)}
              aria-label={t("contacts.deleteContact")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {qrOpen ? (
        <ContactQrModal
          label={contact.label}
          address={contact.address}
          chainId={chainId}
          explorerUrl={explorerUrl}
          onClose={() => setQrOpen(false)}
        />
      ) : null}
    </div>
  );
});

function ContactSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-surface-2" />
        <div className="flex-1 space-y-1.5 pt-1">
          <span className="block h-3.5 w-24 animate-pulse rounded bg-surface-2" />
          <span className="block h-2.5 w-32 animate-pulse rounded bg-surface-2/70" />
        </div>
      </div>
      <span className="block h-2.5 w-3/4 animate-pulse rounded bg-surface-2/60" />
    </div>
  );
}

export default function ContactsPage() {
  const { t } = useI18n();
  const { data: contacts, isLoading } = useContacts();
  const createContact = useCreateContact();
  const chainId = useChainId();
  // R13-A: payments joined onto the address book (shared query key with the
  // payments page — one local read, cached across navigation).
  const { data: paymentsData } = usePayments();
  const payments = paymentsData?.payments;

  const [mounted, setMounted] = useState(false);
  useEffect(() => { startTransition(() => setMounted(true)); }, []);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState({ label: "", address: "", note: "" });
  const [formError, setFormError] = useState<string | null>(null);

  // Explorer for contact addresses: the active chain when connected, else the
  // app default (Creditcoin TN).
  const explorerBase = (getChainByChainId(chainId) ?? getChainByChainId(102031))?.explorerUrl ?? null;

  const rows = useMemo(() => contacts ?? [], [contacts]);

  // Payment rollups keyed by canonical payee address (checksum or lowercase
  // fallback). Recomputed only when either cache actually changes.
  const rollups = useMemo(
    () => (payments && payments.length > 0 ? rollupsByPayee(payments) : null),
    [payments],
  );

  // Favorites pinned first, then most-recently-used.
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return b.lastUsed - a.lastUsed;
    });
  }, [rows]);

  const filtered = useMemo(() => {
    return sorted.filter((c) => {
      if (showFavoritesOnly && !c.favorite) return false;
      if (!deferredQuery) return true;
      const q = deferredQuery.toLowerCase();
      return (
        c.label.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q) ||
        (c.note ?? "").toLowerCase().includes(q)
      );
    });
  }, [sorted, deferredQuery, showFavoritesOnly]);

  const stats = useMemo(() => {
    const favoritesCount = rows.filter((c) => c.favorite).length;
    const recentlyUsedCount = rows.filter((c) => LOAD_TIME - c.lastUsed < DAY_MS && c.lastUsed > 0).length;
    return { favoritesCount, recentlyUsedCount };
  }, [rows]);

  // Live address validation state for the add form.
  const addressState = useMemo(() => {
    const raw = form.address.trim();
    if (!raw) return "empty" as const;
    if (!/^0x[0-9a-fA-F]*$/.test(raw)) return "invalid" as const;
    if (raw.length !== 42) return "partial" as const;
    if (!isAddress(raw)) return "invalid" as const;
    const existing = rows.find((c) => c.address.toLowerCase() === raw.toLowerCase());
    if (existing) return "duplicate" as const;
    return "valid" as const;
  }, [form.address, rows]);

  const duplicateOf = useMemo(() => {
    const raw = form.address.trim().toLowerCase();
    return rows.find((c) => c.address.toLowerCase() === raw) ?? null;
  }, [form.address, rows]);

  const resetForm = useCallback(() => {
    setForm({ label: "", address: "", note: "" });
    setFormError(null);
  }, []);

  const handleAdd = useCallback(async () => {
    setFormError(null);
    if (!form.label.trim()) {
      setFormError(t("contacts.errorNameRequired"));
      return;
    }
    if (addressState !== "valid") {
      setFormError(t("contacts.errorAddressRequired"));
      return;
    }
    try {
      await createContact.mutateAsync({
        label: form.label.trim(),
        address: getAddress(form.address.trim()),
        note: form.note.trim(),
      });
      resetForm();
      setShowAddForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("contacts.errorFailed"));
    }
  }, [form, createContact, resetForm, t, addressState]);

  if (!mounted) {
    return (
      <PageContainer
        title={t("contacts.title")}
        description={t("contacts.desc")}
        icon={<Users className="h-5 w-5" />}
      >
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("contacts.loading")}
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer
      title={t("contacts.title")}
      description={t("contacts.desc")}
      icon={<Users className="h-5 w-5" />}
      action={
        <Button variant="primary" size="sm" onClick={() => setShowAddForm((v) => !v)}>
          <Plus className="h-4 w-4" />
          {t("contacts.addContact")}
        </Button>
      }
    >
      {showAddForm ? (
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <AddressBookIcon />
              {t("contacts.newContact")}
            </h2>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                resetForm();
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
              aria-label={t("contacts.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-3">
            <div>
              <label htmlFor="contact-name" className="text-xs text-muted">{t("contacts.name")}</label>
              <input
                id="contact-name"
                type="text"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder={t("contacts.namePlaceholder")}
                className="neumorphic-inset mt-1 w-full rounded-xl border border-border bg-surface-2/50 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-2 focus:border-primary/40 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="contact-address" className="flex items-center justify-between text-xs text-muted">
                <span>{t("contacts.address")}</span>
                {addressState === "valid" ? (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-success">
                    <Check className="h-3 w-3" /> {t("contacts.addressValid")}
                  </span>
                ) : addressState === "duplicate" && duplicateOf ? (
                  <span className="truncate text-[10px] font-medium text-warning">
                    {t("contacts.duplicateOf", { name: duplicateOf.label })}
                  </span>
                ) : addressState === "invalid" ? (
                  <span className="text-[10px] font-medium text-danger">{t("contacts.addressInvalid")}</span>
                ) : null}
              </label>
              <input
                id="contact-address"
                type="text"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className={cn(
                  "neumorphic-inset mt-1 w-full rounded-xl border bg-surface-2/50 px-3 py-2.5 font-mono text-sm text-foreground placeholder:font-sans placeholder:text-muted-2 focus:outline-none",
                  addressState === "valid"
                    ? "border-success/40 focus:border-success/60"
                    : addressState === "duplicate"
                      ? "border-warning/40 focus:border-warning/60"
                      : addressState === "invalid"
                        ? "border-danger/40 focus:border-danger/60"
                        : "border-border focus:border-primary/40",
                )}
              />
            </div>
            <div>
              <label htmlFor="contact-note" className="text-xs text-muted">{t("contacts.noteOptional")}</label>
              <input
                id="contact-note"
                type="text"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder={t("contacts.notePlaceholder")}
                className="neumorphic-inset mt-1 w-full rounded-xl border border-border bg-surface-2/50 px-3 py-2.5 text-sm text-foreground placeholder:text-muted-2 focus:border-primary/40 focus:outline-none"
              />
            </div>

            {formError ? (
              <p className="flex items-center gap-2 text-xs text-danger">
                <AlertCircle className="h-3.5 w-3.5" />
                {formError}
              </p>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowAddForm(false);
                  resetForm();
                }}
              >
                {t("contacts.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleAdd}
                disabled={createContact.isPending || addressState === "duplicate"}
              >
                {createContact.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {t("contacts.saveContact")}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <FinderSearch
          value={query}
          onChange={setQuery}
          placeholder={t("contacts.searchPlaceholder")}
          ariaLabel={t("contacts.searchPlaceholder")}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowFavoritesOnly((v) => !v)}
            aria-pressed={showFavoritesOnly}
            className={cn(
              "flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60",
              showFavoritesOnly
                ? "bg-warning/15 text-warning ring-1 ring-inset ring-warning/30"
                : "glass-item text-muted hover:text-foreground",
            )}
          >
            <Star className={cn("h-3.5 w-3.5", showFavoritesOnly && "fill-current")} />
            {t("contacts.favorites")} {stats.favoritesCount > 0 ? `· ${stats.favoritesCount}` : ""}
          </button>
          <span className="text-[10px] text-muted-3">
            {stats.recentlyUsedCount > 0
              ? t("contacts.statsLine", { total: rows.length, recent: stats.recentlyUsedCount })
              : t("contacts.statsLineIdle", { total: rows.length })}
          </span>
        </div>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-busy>
          <ContactSkeleton />
          <ContactSkeleton />
          <ContactSkeleton />
          <ContactSkeleton />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title={rows.length === 0 ? t("contacts.noContacts") : t("contacts.noContactsFound")}
          description={
            rows.length === 0
              ? t("contacts.noContactsDesc")
              : t("contacts.noContactsFoundDesc")
          }
          action={
            <Button variant="primary" size="sm" onClick={() => setShowAddForm(true)}>
              <Plus className="h-4 w-4" />
              {t("contacts.addContact")}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((contact) => (
            <ContactCard
              key={contact.id}
              contact={contact}
              explorerBase={explorerBase}
              chainId={chainId}
              rollup={rollups?.get(payeeKey(contact.address))}
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
