"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifyContactsChanged } from "@/lib/chat/mentions";
import type { ContactRow, PaymentRow } from "@/db/schema";

export type Payment = PaymentRow;
export type Contact = ContactRow;

const PAYMENTS_KEY = ["payments"] as const;
const CONTACTS_KEY = ["contacts"] as const;

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? "Request failed");
  }
  return (await res.json()) as T;
}

export interface CreatePaymentPayload {
  recipientAddress: string;
  recipientLabel: string | null;
  token: string;
  tokenAddress?: string | null;
  amountHuman: string;
  memo?: string | null;
  chainId: number;
  senderAddress: string | null;
}

export interface UpdatePaymentPayload {
  id: string;
  status?: string;
  txHash?: string;
  chainId?: number;
  senderAddress?: string | null;
  tokenAddress?: string | null;
}

export interface CreateContactPayload {
  label: string;
  address: string;
  note?: string;
  favorite?: boolean;
}

export interface UpdateContactPayload {
  id: string;
  label?: string;
  note?: string;
  favorite?: boolean;
}

export function usePayments() {
  return useQuery({
    queryKey: PAYMENTS_KEY,
    // 30s refetch keeps the Attestcoin watcher strip ("watching N · last check
    // Xs ago") in step with the server poller's 60s tick — the route is a
    // local DB read, so the cost is negligible.
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch("/api/payments", { cache: "no-store" });
      const data = await parseJson<{
        payments: Payment[];
        /** Signed-submission availability (env check surfaced by the route). */
        submission: SubmissionAvailability;
        /** Attestcoin watcher liveness (in-memory stats + watching count). */
        poller: {
          running: boolean;
          startedAt: number | null;
          lastTickAt: number | null;
          lastTickChecked: number | null;
          lastFlipAt: number | null;
          flippedTotal: number;
          lastError: string | null;
          watching: number | null;
        };
      }>(res);
      return data;
    },
  });
}

/** Mirrors SubmitAvailability from lib/attestcoin/submit (server route). */
export interface SubmissionAvailability {
  configured: boolean;
  signerAddress?: string;
  requiredEnv?: "CREDITCOIN_SIGNER_KEY";
}

export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreatePaymentPayload) => {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJson<{ payment: Payment }>(res);
      return data.payment;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PAYMENTS_KEY }),
  });
}

export function useUpdatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpdatePaymentPayload) => {
      const res = await fetch(`/api/payments/${payload.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJson<{ payment: Payment }>(res);
      return data.payment;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PAYMENTS_KEY }),
  });
}

export function useDeletePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/payments/${id}`, { method: "DELETE" });
      await parseJson<{ ok: boolean }>(res);
      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PAYMENTS_KEY }),
  });
}

export function useSyncPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/payments/${id}/sync`, { method: "POST" });
      const data = await parseJson<{ payment: Payment; synced: boolean; reason?: string }>(res);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PAYMENTS_KEY }),
  });
}

// ── Attestcoin Protocol attestation lookup for a payment ─────────────────────

export interface PaymentAttestation {
  paymentId: string;
  txHash: string;
  chain: { chainKey: number; evmChainId: number; name: string };
  ok: boolean;
  state: "proof" | "pending" | "unknown_tx" | "error";
  detail?: string;
  proof?: {
    headerNumber: number;
    txIndex: number;
    txHash: string;
    merkleRoot: string;
    merkleSiblings: number;
    continuityLowerEndpoint: string;
    continuityRoots: number;
    cached: boolean;
    generatedAt: string | null;
  };
  /** Result of the read-only Block Prover Precompile (0x0FD2) eth_call. */
  onchain?: {
    verified: boolean;
    txIndex: number | null;
    precompile: string;
    verifiedAt: number;
  } | null;
  /** Whether signed on-chain submission is enabled (CREDITCOIN_SIGNER_KEY). */
  submission?: {
    configured: boolean;
    signerAddress?: string;
    requiredEnv?: string;
  };
  /**
   * C2/G4 — the verified tx decoded from the proof's txBytes via the deployed
   * EvmV1Decoder on Creditcoin (protocol-native source of truth).
   */
  decoded?: {
    type: number;
    from: string;
    to: string | null;
    valueEther: string;
    dataPreview: string | null;
    nonce: number;
    receiptStatus: "success" | "reverted" | null;
    receiptGasUsed: number | null;
    decodedAt: number;
  } | null;
  /** C2/G7 — verification cost estimate + freshness verdict. */
  cost?: {
    continuityRoots: number;
    estimatedCtc: number;
    ctcLabel: string;
    stale: boolean;
    staleGapBlocks: number | null;
  } | null;
  /** C2/G6 — the attestation bracket while the tx waits (pending state only). */
  bounds?: {
    parentHeight: number;
    parentHash: string;
    parentIsAttestation: boolean;
    childHeight: number;
    childHash: string;
    childIsAttestation: boolean;
    isAttested: boolean;
  } | null;
  network?: {
    env: string;
    cc3Block: number | null;
    attestedHeight: number | null;
    sourceHead: number | null;
    lag: number | null;
  } | null;
}

export interface AttestSubmitResult {
  ok: boolean;
  already?: boolean;
  cc3TxHash?: string | null;
  event?: { chainKey: number; height: number; transactionIndex: number } | null;
  gasUsed?: number | null;
  signerAddress?: string;
  env?: string;
  /** Present on the 501 “not configured” response. */
  configured?: boolean;
  requiredEnv?: string;
  hint?: string;
  error?: string;
  detail?: string;
}

export function useAttestPayment() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/payments/${id}/attestcoin`, { cache: "no-store" });
      return parseJson<PaymentAttestation>(res);
    },
  });
}

// ── Attestcoin certificate verification (help-page verifier tool) ───────────

export interface CertificateCheckResult {
  id: "schema" | "consistency" | "builder" | "onchain" | "receipt";
  status: "pass" | "fail" | "skip";
  detail: string;
  data?: Record<string, unknown>;
}

export interface CertificateVerifyResponse {
  ok: boolean;
  network: string;
  chain?: { chainKey: number; evmChainId: number; name: string };
  txHash?: string;
  checks: CertificateCheckResult[];
  payment?: Record<string, unknown> | null;
  certificateExportedAt?: string | null;
  error?: string;
}

/** Re-verify an exported attestation certificate against live chain data. */
export function useVerifyCertificate() {
  return useMutation({
    mutationFn: async (certificateText: string) => {
      const res = await fetch("/api/attestcoin/verify-certificate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Client pre-validates JSON so 400s are rare; parseJson throws with
        // the server's message otherwise (e.g. "Certificate too large.").
        body: certificateText,
        cache: "no-store",
      });
      return parseJson<CertificateVerifyResponse>(res);
    },
  });
}

/** Submit the payment's proof to the Block Prover Precompile (WRITE half). */
export function useSubmitAttestation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/payments/${id}/attest`, {
        method: "POST",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as AttestSubmitResult;
      // 501 (not configured) is an expected, structured response — surface the
      // body instead of throwing so the UI can render the guidance hint.
      if (!res.ok && res.status !== 501) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return { status: res.status, ...body };
    },
    onSuccess: () => {
      // The payments list carries cc3TxHash/onchainVerifiedAt columns.
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
    },
  });
}

export interface BatchAttestResult {
  ok: boolean;
  submittedCount?: number;
  persistedCount?: number;
  skipped?: { id: string; reason: "pending" | "unsupported_chain" }[];
  cc3TxHash?: string;
  events?: { chainKey: number; height: number; transactionIndex: number }[];
  gasUsed?: number | null;
  signerAddress?: string;
  env?: string;
  /** Present on the 501 “not configured” response. */
  configured?: boolean;
  requiredEnv?: string;
  hint?: string;
  error?: string;
  detail?: string;
}

/** Submit every ready proof in ONE verifyAndEmitBatch tx per source chain. */
export function useSubmitAttestationBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/payments/attest-batch", {
        method: "POST",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as BatchAttestResult;
      // 501 (not configured) and 409 (nothing ready yet) are structured
      // responses — surface the body instead of throwing.
      if (!res.ok && res.status !== 501 && res.status !== 409) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return { status: res.status, ...body };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
    },
  });
}

export interface RecentAttestationRow {
  id: string;
  recipientLabel: string | null;
  recipientAddress: string;
  token: string;
  amountHuman: string;
  chainId: number;
  chainName: string;
  attestedAt: number;
  attestRoot: string | null;
  onchainVerified: boolean;
  submitted: boolean;
}

/** Payment-side attestation feed for the wallet panel (local DB, no network). */
export function useRecentAttestations() {
  return useQuery({
    queryKey: ["attestcoin-recent"],
    queryFn: async () => {
      const res = await fetch("/api/attestcoin/recent", { cache: "no-store" });
      const data = await parseJson<{ recent: RecentAttestationRow[] }>(res);
      return data.recent;
    },
    refetchInterval: 45_000,
  });
}

export function useContacts() {
  return useQuery({
    queryKey: CONTACTS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/contacts", { cache: "no-store" });
      const data = await parseJson<{ contacts: Contact[] }>(res);
      return data.contacts;
    },
  });
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateContactPayload) => {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJson<{ contact: Contact }>(res);
      return data.contact;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: CONTACTS_KEY }); notifyContactsChanged(); },
    onError: () => { qc.invalidateQueries({ queryKey: CONTACTS_KEY }); notifyContactsChanged(); },
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpdateContactPayload) => {
      const res = await fetch(`/api/contacts/${payload.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJson<{ contact: Contact }>(res);
      return data.contact;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: CONTACTS_KEY }); notifyContactsChanged(); },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/contacts/${id}`, { method: "DELETE" });
      await parseJson<{ ok: boolean }>(res);
      return id;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: CONTACTS_KEY }); notifyContactsChanged(); },
  });
}

// ─── Recurring schedules ─────────────────────────────────────────────────────

import type { RecurringRow } from "@/db/schema";

export type RecurringSchedule = RecurringRow;

const RECURRING_KEY = ["recurring"] as const;

export interface CreateRecurringPayload {
  id: string;
  recipientLabel?: string | null;
  recipientAddress: string;
  token?: string;
  tokenAddress?: string | null;
  amountHuman: string;
  amountBaseUnits: string;
  cadence: string;
  chainId?: number | null;
  nextFireAt: number;
  maxExecutions: number;
  scheduleIdHash: string;
  senderAddress: string;
  userId?: string | null;
}

export interface UpdateRecurringPayload {
  id: string;
  active?: boolean;
  executions?: number;
  lastFireAt?: number | null;
  nextFireAt?: number;
  lastStatus?: string | null;
  /** Requeue after a busy-run race (restores pre-fire state; see lib/recurring/fire.ts). */
  requeue?: boolean;
}

export function useRecurringSchedules() {
  return useQuery({
    queryKey: RECURRING_KEY,
    queryFn: async () => {
      const res = await fetch("/api/recurring", { cache: "no-store" });
      const data = await parseJson<{ schedules: RecurringSchedule[] }>(res);
      return data.schedules;
    },
  });
}

export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateRecurringPayload) => {
      const res = await fetch("/api/recurring", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJson<{ schedule: RecurringSchedule }>(res);
      return data.schedule;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RECURRING_KEY }),
  });
}

export function useUpdateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpdateRecurringPayload) => {
      const res = await fetch(`/api/recurring/${payload.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJson<{ schedule: RecurringSchedule }>(res);
      return data.schedule;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RECURRING_KEY }),
  });
}

export function useDeleteRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/recurring/${id}`, { method: "DELETE" });
      await parseJson<{ ok: boolean }>(res);
      return id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RECURRING_KEY }),
  });
}

/** Manual "Run now" fire: returns the schedule + pre-fire state so the caller
 * can dispatch through the agent loop and requeue on a busy race. */
export interface FireRecurringResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  schedule?: RecurringSchedule;
  previous?: { executions: number; nextFireAt: number; active: boolean };
}

export function useFireRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<FireRecurringResult> => {
      const res = await fetch(`/api/recurring/${id}/fire`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "dispatched" }),
      });
      if (!res.ok) throw new Error("Fire request failed.");
      return (await res.json()) as FireRecurringResult;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RECURRING_KEY }),
  });
}
