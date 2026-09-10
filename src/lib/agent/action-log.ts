import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, ensureDb } from "@/db";
import { agentActions, type AgentActionRow } from "@/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// The persistent, user-visible action log (brief §5): every action the agent
// takes or attempts — what tool, what it did, the outcome, and the proof /
// tx-hash references that authorized or backed it. This is a product feature
// (verifiability), not just internal logging.
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionStart {
  runId: string;
  /** Tool-call id — the join key for live lifecycle overlays (§4.6). */
  callId?: string;
  tool: string;
  params: Record<string, unknown>;
  riskClass: string;
  chainId?: number | null;
  usdValueCents?: number | null;
  confirmationRequired: boolean;
  sourceTxHash?: string | null;
}

export interface ActionPatch {
  status?: string;
  result?: Record<string, unknown>;
  cc3TxHash?: string | null;
  attestRoot?: string | null;
  sourceTxHash?: string | null;
  chainId?: number | null;
}

export function startAction(input: ActionStart): string {
  ensureDb();
  const id = randomUUID();
  db.insert(agentActions)
    .values({
      id,
      runId: input.runId,
      callId: input.callId ?? null,
      tool: input.tool,
      paramsJson: JSON.stringify(input.params),
      status: "running",
      chainId: input.chainId ?? null,
      usdValueCents: input.usdValueCents != null ? Math.round(input.usdValueCents) : null,
      riskClass: input.riskClass,
      confirmationRequired: input.confirmationRequired,
      sourceTxHash: input.sourceTxHash ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function patchAction(id: string, patch: ActionPatch): void {
  ensureDb();
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.result !== undefined) set.resultJson = JSON.stringify(patch.result);
  if (patch.cc3TxHash !== undefined) set.cc3TxHash = patch.cc3TxHash;
  if (patch.attestRoot !== undefined) set.attestRoot = patch.attestRoot;
  if (patch.sourceTxHash !== undefined) set.sourceTxHash = patch.sourceTxHash;
  if (patch.chainId !== undefined) set.chainId = patch.chainId;
  if (patch.status && ["succeeded", "failed", "declined", "interrupted"].includes(patch.status)) {
    set.completedAt = Date.now();
  }
  if (Object.keys(set).length === 0) return;
  db.update(agentActions).set(set).where(eq(agentActions.id, id)).run();
}

export function listActions(limit = 20): AgentActionRow[] {
  ensureDb();
  return db.select().from(agentActions).orderBy(desc(agentActions.createdAt)).limit(limit).all();
}

/**
 * Post-run resolution (§4.6 "the log catches up from the receipt"): the
 * background receipt tracker reports a terminal status for a call whose run
 * already ended — the session binding may be gone (swept, or another
 * serverless container), so resolve the action row by callId directly.
 * Only flips a row that is still non-terminal ("unknown"/"broadcast"/…);
 * a row the run itself already finalized stays authoritative. Returns
 * whether a row was found and patched.
 */
export function resolveActionByCall(callId: string, status: string, patch: ActionPatch): boolean {
  ensureDb();
  const rows = db
    .select()
    .from(agentActions)
    .where(eq(agentActions.callId, callId))
    .orderBy(desc(agentActions.createdAt))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return false;
  if (["succeeded", "failed", "declined", "interrupted"].includes(row.status)) return false;
  patchAction(row.id, { status, ...patch });
  return true;
}

/**
 * P10 fund-safety guard: find prior actions of a tool whose transaction may
 * still be in flight (status "unknown"/"broadcast"/"signed" — broadcast but
 * receipt never arrived). A user- or model-initiated RETRY of the same call
 * must check these on-chain BEFORE re-sending; a blind re-send risks a
 * double-spend (hard boundary 7).
 * Match key: tool + canonically-serialized args (sorted keys — the model's
 * key order on a retry need not match the original emission; a different call
 * simply won't match).
 */
export function priorUnknownTxActions(tool: string, argsJson: string, limit = 5): AgentActionRow[] {
  ensureDb();
  const canonical = (s: string): string | null => {
    try {
      const sortDeep = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sortDeep);
        if (v && typeof v === "object") {
          const o: Record<string, unknown> = {};
          for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            o[k] = sortDeep((v as Record<string, unknown>)[k]);
          }
          return o;
        }
        return v;
      };
      return JSON.stringify(sortDeep(JSON.parse(s)));
    } catch {
      return null;
    }
  };
  const want = canonical(argsJson);
  if (want == null) return [];
  const rows = db
    .select()
    .from(agentActions)
    .where(eq(agentActions.tool, tool))
    .orderBy(desc(agentActions.createdAt))
    .limit(200)
    .all();
  const out: AgentActionRow[] = [];
  for (const row of rows) {
    if (!["unknown", "broadcast", "signed"].includes(row.status)) continue;
    const got = canonical(row.paramsJson ?? "");
    if (got !== want) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * P24: log a NON-AGENT mutation (UI-initiated contact/recurring/automation/
 * skill changes, payment settlements, attestation submissions) to the same
 * user-visible action log the agent's tool calls land in. Called server-side
 * right after the successful DB write. NEVER log API keys or secrets.
 */
export function logAppAction(input: {
  tool: string;
  params: Record<string, unknown>;
  status: "succeeded" | "failed" | "declined";
  summary: string;
  riskClass?: string;
  chainId?: number | null;
  txHash?: string | null;
  cc3TxHash?: string | null;
  attestRoot?: string | null;
  sourceTxHash?: string | null;
}): string {
  const id = startAction({
    runId: `app-${Date.now().toString(36)}`,
    tool: input.tool,
    params: input.params,
    riskClass: input.riskClass ?? "config",
    chainId: input.chainId ?? null,
    confirmationRequired: false,
    sourceTxHash: input.sourceTxHash ?? null,
  });
  patchAction(id, {
    status: input.status,
    result: {
      ok: input.status === "succeeded",
      summary: input.summary,
      ...(input.txHash ? { txHash: input.txHash } : {}),
      ...(input.chainId != null ? { chainId: input.chainId } : {}),
    },
    ...(input.cc3TxHash ? { cc3TxHash: input.cc3TxHash } : {}),
    ...(input.attestRoot ? { attestRoot: input.attestRoot } : {}),
  });
  return id;
}

/** Mark non-terminal actions of a run as interrupted (client disconnect / abort).
 * Broadcast rows keep their status — the transaction may still land on-chain;
 * the honest state stays "broadcast" until the user checks it (never silently
 * overwritten, and never auto-resent — hard boundary 7). */
export function interruptRunningActions(runId: string): void {
  ensureDb();
  const rows = db.select().from(agentActions).where(eq(agentActions.runId, runId)).all();
  for (const row of rows) {
    if (["pending", "awaiting_confirmation", "awaiting_signature", "running"].includes(row.status)) {
      patchAction(row.id, {
        status: "interrupted",
        result: { ok: false, summary: "Run interrupted (page closed or stopped) before this action finished." },
      });
    }
  }
}
