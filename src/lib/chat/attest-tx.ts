// ─────────────────────────────────────────────────────────────────────────────
// AC11 (Task 8): client-safe Attestcoin helpers for the CHAT surface.
//
// Shared by the per-message Attestcoin action row
// (src/components/attestcoin-tx-actions.tsx) and the composer quick-check
// popover (src/components/attestcoin-quick-check.tsx). Both are NATIVE — they
// call the app's own attestcoin API routes directly, never the agent loop.
//
// This module deliberately types every fetch LOCALLY (lib/api.ts is owned by
// another task) and imports NOTHING from src/lib/attestcoin/* — those modules
// pull the @gluwa/usc-sdk and are server-only. All shapes below mirror the
// JSON the routes actually emit (see src/app/api/attestcoin/proof/route.ts,
// recent/route.ts, certificate/route.ts, verify-certificate/route.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessageData } from "@/lib/types";

/** Tracked Attestcoin SOURCE chains (mirrors SOURCE_CHAINS in the server
 * config: Sepolia 11155111 + Ethereum 1). The Creditcoin destination chains
 * (102031 / 102030) are deliberately NOT in this set — CC3 never attests
 * itself (same exclusion rule as the poller's isAttestableAction, AC8). */
export const ATTEST_SOURCE_CHAIN_IDS: ReadonlySet<number> = new Set([11155111, 1]);

/** Chain ids offered by the quick-check popover's chain select (Sepolia
 * first — it is the default). Display names/icons come from the chain
 * registry, never hardcoded here. */
export const ATTEST_SOURCE_CHAIN_OPTIONS: ReadonlyArray<number> = [11155111, 1];

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/**
 * AC11 — cap on how many distinct tx rows one message can render. A
 * batch_transfer can carry a handful of txs; a full "+N more" collapse is
 * over-engineering for a chat affordance, so we show the LATEST two (the
 * latest tx is almost always the main action the user just took).
 */
const MAX_TX_ROWS = 2;

export interface TrackedTx {
  txHash: string;
  chainId: number;
  /** Explorer URL carried by the trace step (may be absent; consumers fall
   * back to the chain registry). */
  explorerUrl?: string;
}

/**
 * Extract the tracked source-chain transactions from a chat message's agent
 * trace (steps carry detail.txHash / result.txHash + chainId, and optionally
 * detail.explorerUrl). Latest-first ordering (the last step's tx is usually
 * the main action), deduped by (txHash, chainId), capped at MAX_TX_ROWS.
 * Only chains inside ATTEST_SOURCE_CHAIN_IDS qualify — this automatically
 * skips Creditcoin destination txs (execute_conditional_release rows) and
 * untracked chains, exactly like the server-side poller eligibility rule.
 */
export function extractTrackedTxs(message: ChatMessageData): TrackedTx[] {
  const steps = message.trace ?? [];
  const out: TrackedTx[] = [];
  const seen = new Set<string>();
  for (let i = steps.length - 1; i >= 0 && out.length < MAX_TX_ROWS; i--) {
    const step = steps[i];
    const txHash = step.detail?.txHash ?? step.result?.txHash;
    if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) continue;
    const chainId = step.detail?.chainId ?? step.result?.chainId;
    if (typeof chainId !== "number" || !ATTEST_SOURCE_CHAIN_IDS.has(chainId)) continue;
    const key = `${txHash.toLowerCase()}:${chainId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      txHash,
      chainId,
      explorerUrl: typeof step.detail?.explorerUrl === "string" ? step.detail.explorerUrl : undefined,
    });
  }
  return out;
}

// ── GET /api/attestcoin/proof response (raw is stripped server-side) ─────────

export interface AttestProofData {
  state: "proof" | "pending" | "unknown_tx" | "error";
  proof?: {
    chainKey: number;
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
  detail?: string;
  onchain?: {
    verified: boolean;
    txIndex: number | null;
    precompile: string;
    verifiedAt: number;
  };
  cost?: {
    continuityRoots: number;
    estimatedCtc: number;
    ctcLabel: string;
    stale: boolean;
    staleGapBlocks: number | null;
  };
  bounds?: {
    parentHeight: number;
    childHeight: number;
    isAttested: boolean;
  };
  chain: { chainKey: number; evmChainId: number; name: string };
  env: "testnet" | "mainnet";
  dashboard: string;
  /** Client-side stamp so the UI can render "checked …" honestly. */
  fetchedAt: number;
}

const PROOF_TIMEOUT_MS = 12_000;

/**
 * Read-only proof lookup for a source-chain tx (GET /api/attestcoin/proof?
 * evmChainId=…&txHash=…). Throws on network failure or non-OK HTTP — callers
 * render the message honestly. A builder outage surfaces as HTTP 502 with the
 * server's detail in the body, which we forward.
 */
export async function fetchTxProof(txHash: string, evmChainId: number): Promise<AttestProofData> {
  let res: Response;
  try {
    res = await fetch(`/api/attestcoin/proof?evmChainId=${evmChainId}&txHash=${txHash}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  }
  const data = (await res.json()) as Omit<AttestProofData, "fetchedAt">;
  return { ...data, fetchedAt: Date.now() };
}

/**
 * AC11 — client-side twin of the server's estimateVerificationCtc
 * (src/lib/attestcoin/proof.ts): CTC ≈ 2.3e-5 + 2.9e-7 × continuity roots.
 * Duplicated rather than imported because the server module pulls the whole
 * @gluwa/usc-sdk into the bundle. The proof API normally returns `cost`
 * pre-computed (same formula) — this is only the fallback for responses that
 * lack it while still carrying a proof.
 */
export function estimateVerificationCtcClient(continuityRoots: number): number {
  return 2.3e-5 + 2.9e-7 * Math.max(continuityRoots, 0);
}

/** Trim trailing zeros the same way the server's ctcLabel does. */
export function formatCtcLabel(estimatedCtc: number): string {
  return `≈${estimatedCtc.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} CTC`;
}

/** Resolve the cost label for a proof response: prefer the server-computed
 * `cost.ctcLabel`, fall back to the local formula when absent. */
export function proofCostLabel(data: AttestProofData): string | null {
  if (data.cost) return data.cost.ctcLabel;
  if (data.proof) return formatCtcLabel(estimateVerificationCtcClient(data.proof.continuityRoots));
  return null;
}

// ── GET /api/attestcoin/recent — the merged payments+actions feed (AC8) ──────

/** The action rows of the merged feed (payment rows carry no txHash, so only
 * action rows can be matched by hash). Field-checked one by one — no casts. */
export interface RecentActionFeedRow {
  id: string;
  tool: string;
  txHash: string | null;
  chainId: number | null;
  chainName: string;
  attestedAt: number;
  attestRoot: string | null;
  onchainVerified: boolean;
  cc3TxHash: string | null;
}

/**
 * Fetch the recent-attestations feed and return its ACTION rows, validated
 * field-by-field (defensive: the feed is additive and other tasks may extend
 * it). Note the feed is capped at 6 rows server-side — an attested tx older
 * than that window will honestly NOT be found.
 */
export async function fetchRecentActionRows(): Promise<RecentActionFeedRow[]> {
  let res: Response;
  try {
    res = await fetch("/api/attestcoin/recent", {
      cache: "no-store",
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { recent?: unknown[] };
  const rows: RecentActionFeedRow[] = [];
  for (const raw of Array.isArray(data.recent) ? data.recent : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.type !== "action") continue;
    if (typeof r.id !== "string" || typeof r.tool !== "string") continue;
    rows.push({
      id: r.id,
      tool: r.tool,
      txHash: typeof r.txHash === "string" ? r.txHash : null,
      chainId: typeof r.chainId === "number" ? r.chainId : null,
      chainName: typeof r.chainName === "string" ? r.chainName : "",
      attestedAt: typeof r.attestedAt === "number" ? r.attestedAt : 0,
      attestRoot: typeof r.attestRoot === "string" ? r.attestRoot : null,
      onchainVerified: r.onchainVerified === true,
      cc3TxHash: typeof r.cc3TxHash === "string" ? r.cc3TxHash : null,
    });
  }
  return rows;
}

/** Match an action feed row by source tx hash (case-insensitive). */
export function matchActionRowByTx(rows: RecentActionFeedRow[] | null, txHash: string): RecentActionFeedRow | null {
  if (!rows) return null;
  const needle = txHash.toLowerCase();
  return rows.find((r) => typeof r.txHash === "string" && r.txHash.toLowerCase() === needle) ?? null;
}

// ── GET /api/attestcoin/certificate?type=action&id=… — download ──────────────

export type CertificateOutcome =
  | { ok: true; filename: string }
  | { ok: false; reason: "not_found" | "error"; message?: string };

/**
 * Download the verifiable certificate (acp.attestation-certificate/v1 JSON)
 * for an attested AGENT ACTION row id. Fetch+blob rather than window.open so
 * a 409 "not attested yet" surfaces as an inline, localized error instead of
 * a raw JSON tab (same pattern as the actions page's AC6 export button).
 */
export async function downloadActionCertificate(actionId: string): Promise<CertificateOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/attestcoin/certificate?type=action&id=${encodeURIComponent(actionId)}`, {
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "error" };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: "error", message: body.error ?? `HTTP ${res.status}` };
  }
  const blob = await res.blob().catch(() => null);
  if (!blob) return { ok: false, reason: "error" };
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? `acp-certificate-action-${actionId}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { ok: true, filename };
}

// ── POST /api/attestcoin/verify-certificate — verdict shape ──────────────────

export interface CertificateCheck {
  id: "schema" | "consistency" | "builder" | "onchain" | "receipt";
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface CertificateVerdict {
  ok: boolean;
  network: string;
  chain?: { chainKey: number; evmChainId: number; name: string };
  txHash?: string;
  checks: CertificateCheck[];
  certificateExportedAt?: string | null;
}

/**
 * Verify a pasted certificate JSON against LIVE chains (schema / consistency /
 * builder / on-chain precompile / receipt — see the route header). The body is
 * the raw certificate text exactly as exported. Throws with the server's
 * message on 4xx/5xx (e.g. "Body is not valid JSON.") so callers can show it.
 */
export async function verifyCertificate(certificateText: string): Promise<CertificateVerdict> {
  let res: Response;
  try {
    res = await fetch("/api/attestcoin/verify-certificate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: certificateText,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  const data = (await res.json().catch(() => ({}))) as CertificateVerdict & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
