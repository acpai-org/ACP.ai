import { createPublicClient, http, type PublicClient } from "viem";
import { erc20Abi } from "viem";
import { db, ensureDb } from "@/db";
import { contacts, recurringSchedules, agentActions, automationRules, payments } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { CHAIN_REGISTRY, getChainByChainId } from "@/lib/chains/registry";
import { VIEM_CHAINS } from "@/lib/chains/registry";
import { getTxProof, proofCostContext } from "@/lib/attestcoin/proof";
import { verifyProofOnChain } from "@/lib/attestcoin/verify";
import { submissionAvailability, submitProofOnChain } from "@/lib/attestcoin/submit";
import { getAttestcoinStatus, getAttestationBounds } from "@/lib/attestcoin/status";
import { attestcoinEndpoints, attestcoinEnv } from "@/lib/attestcoin/config";
import { cc3ExplorerTxUrl } from "@/lib/attestcoin/cc3-links";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";
import { decodeTxBytes } from "@/lib/attestcoin/decode";
import { proofProvider } from "@gluwa/usc-sdk";
import { cadenceIntervalMs, cadenceLabelEn, formatIntervalHuman } from "@/lib/recurring/cadence";
import {
  AUTOMATION_RULE_CAP,
  validateAction,
  validateTriggerConfig,
  isTriggerType,
  serializeRule,
} from "@/lib/automation/validate";
import type { AutomationActionConfig } from "@/lib/automation/types";
import { validateCreateContact } from "@/lib/payment";
import { listActions } from "@/lib/agent/action-log";
import { executeAttestcoinStatus } from "@/lib/ai/tool-impls";
import type { WalletContext } from "@/lib/ai/system-prompt";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side tool executors — read-only lookups + config writes. These run
// inside the Next.js server (viem public clients over the registry's RPCs);
// they never touch the user's wallet and never move funds.
// ─────────────────────────────────────────────────────────────────────────────

const G = globalThis as unknown as { __acpPublicClients?: Map<number, PublicClient> };

function publicClient(chainId: number): PublicClient | null {
  const chain = getChainByChainId(chainId);
  if (!chain) return null;
  if (!G.__acpPublicClients) G.__acpPublicClients = new Map();
  let client = G.__acpPublicClients.get(chainId);
  if (!client) {
    client = createPublicClient({
      chain: VIEM_CHAINS[chainId],
      transport: http(chain.rpcUrls[0], { timeout: 10_000, retryCount: 1 }),
    });
    G.__acpPublicClients.set(chainId, client);
  }
  return client;
}

function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return (neg ? "-" : "") + whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
}

export interface ServerToolContext {
  wallet: WalletContext | null;
  /** Emits a live step-status update (used by wait_for_attestation). */
  onProgress?: (text: string, status?: "waiting_attestation" | "running") => void;
}

export async function execGetBalances(
  args: { chain: number | null },
  ctx: ServerToolContext,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const address = ctx.wallet?.address;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { ok: false, summary: "No connected wallet to read balances from.", error: "no_wallet" };
  }
  const chains = args.chain ? [args.chain] : CHAIN_REGISTRY.map((c) => c.chainId);
  const results: Array<Record<string, unknown>> = [];
  const perChain: Array<{ chainId: number; name: string; native: string; tokens: string[] }> = [];

  await Promise.all(
    chains.map(async (chainId) => {
      const chain = getChainByChainId(chainId);
      const client = publicClient(chainId);
      if (!chain || !client) return;
      try {
        const [nativeBal, blockNumber] = await Promise.all([
          client.getBalance({ address: address as `0x${string}` }),
          client.getBlockNumber(),
        ]);
        const entry = {
          chainId,
          name: chain.name,
          testnet: chain.testnet,
          native: {
            symbol: chain.nativeCurrency.symbol,
            balance: formatUnits(nativeBal, chain.nativeCurrency.decimals),
            raw: nativeBal.toString(),
          },
          blockNumber: Number(blockNumber),
          tokens: [] as Array<{ symbol: string; balance: string; address: string }>,
        };
        // Known tokens (bounded parallel reads).
        await Promise.all(
          chain.tokens.slice(0, 4).map(async (tok) => {
            try {
              const bal = await client.readContract({
                address: tok.address,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [address as `0x${string}`],
              });
              entry.tokens.push({
                symbol: tok.symbol,
                balance: formatUnits(bal, tok.decimals),
                address: tok.address,
              });
            } catch {
              /* token read failed — skip silently */
            }
          }),
        );
        results.push(entry as unknown as Record<string, unknown>);
        perChain.push({
          chainId,
          name: chain.name,
          native: `${entry.native.balance} ${entry.native.symbol}`,
          tokens: entry.tokens.map((t) => `${t.balance} ${t.symbol}`),
        });
      } catch {
        /* chain RPC failed — skip chain */
      }
    }),
  );

  if (results.length === 0) {
    return { ok: false, summary: "Could not read any chain (RPC failures or unknown chain).", error: "rpc" };
  }
  const summary = perChain.map((c) => `${c.name}: ${c.native}${c.tokens.length ? ` + ${c.tokens.join(", ")}` : ""}`).join(" | ");
  return { ok: true, summary, data: { chains: results } };
}

export async function execGetTransactionStatus(
  args: { chain: number; txHash: string },
  _ctx: ServerToolContext,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const client = publicClient(args.chain);
  if (!client) return { ok: false, summary: `Chain ${args.chain} is not supported.`, error: "bad_chain" };
  try {
    const receipt = await client.getTransactionReceipt({ hash: args.txHash as `0x${string}` });
    const currentBlock = await client.getBlockNumber();
    const confirmations = Number(currentBlock) - Number(receipt.blockNumber) + 1;
    const chain = getChainByChainId(args.chain);
    let attestation: Record<string, unknown> | undefined;
    // G1 — live chain-key resolution before the attestation lookup.
    await ensureSourceChainMapFresh();
    const src = sourceChainByEvmId(args.chain);
    if (src) {
      const proof = await getTxProof(src.chainKey, args.txHash);
      // G6 — the attestation bracket for this tx's block (real state, not
      // inferred from builder 404s).
      const bounds = await getAttestationBounds(src.chainKey, Number(receipt.blockNumber)).catch(() => null);
      attestation = {
        tracked: true,
        state: proof.state,
        block: proof.proof?.headerNumber,
        merkleRoot: proof.proof?.merkleRoot,
        ...(bounds
          ? {
              isAttested: bounds.isAttested,
              bracket: {
                parent: bounds.parentHeight,
                parentKind: bounds.parentIsAttestation ? "attestation" : "checkpoint",
                child: bounds.childHeight,
                childKind: bounds.childIsAttestation ? "attestation" : "checkpoint",
              },
            }
          : {}),
      };
    }
    const status = receipt.status === "success" ? "succeeded" : "reverted";
    const summary = `Tx ${args.txHash.slice(0, 12)}… on ${chain?.name}: ${status} at block ${Number(receipt.blockNumber)}, ${confirmations} confirmation(s)${attestation ? `, Attestcoin: ${String(attestation.state)}` : ""}.`;
    return {
      ok: true,
      summary,
      data: {
        status,
        blockNumber: Number(receipt.blockNumber),
        confirmations,
        gasUsed: receipt.gasUsed.toString(),
        explorerUrl: chain?.explorerUrl ? `${chain.explorerUrl}/tx/${args.txHash}` : null,
        attestation,
      },
    };
  } catch {
    // Not mined yet or unknown tx
    const chain = getChainByChainId(args.chain);
    return {
      ok: true,
      summary: `Tx ${args.txHash.slice(0, 12)}… on ${chain?.name}: not found / not mined yet.`,
      data: { status: "unknown" },
    };
  }
}

export async function execCheckAttestation(
  args: { txHash: string; chain?: number | null },
  _ctx: ServerToolContext,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const evmChainId = args.chain ?? 11155111;
  // G1 — live chain-key resolution before anything else.
  await ensureSourceChainMapFresh();
  const src = sourceChainByEvmId(evmChainId);
  if (!src) {
    return { ok: false, summary: `Chain ${evmChainId} is not an Attestcoin source chain this phase (supported: Sepolia).`, error: "unsupported_source" };
  }
  const proof = await getTxProof(src.chainKey, args.txHash);
  if (proof.state === "proof" && proof.proof && proof.raw) {
    const onchain = await verifyProofOnChain(proof.raw).catch(() => null);
    // G4 — decode the verified tx straight from the proof's txBytes: what
    // the proof actually proves (from/to/value + receipt verdict).
    const decoded = await decodeTxBytes(proof.raw.txBytes, args.txHash);
    // G7 — cost/freshness context.
    const attestedHeight = await getAttestcoinStatus()
      .then((s) => s.chains.find((c) => c.chainKey === src.chainKey)?.attestedHeight ?? null)
      .catch(() => null);
    const cost = proofCostContext(proof.proof, attestedHeight);
    const summary = `Proof READY: block ${proof.proof.headerNumber}, ${proof.proof.merkleSiblings} Merkle siblings, ${proof.proof.continuityRoots} continuity roots, verification ${cost.ctcLabel}${cost.stale ? " (STALE — proof is long & pricier)" : ""}${onchain ? `, on-chain BlockProver verdict: ${onchain.verified ? "VERIFIED" : "FAILED"}` : ""}${decoded ? `, decoded: type-${decoded.type} ${decoded.from.slice(0, 10)}… → ${decoded.to ? decoded.to.slice(0, 10) + "…" : "contract creation"} ${decoded.valueEther} ETH, receipt ${decoded.receiptStatus ?? "?"}` : ""}.`;
    return {
      ok: true,
      summary,
      data: {
        state: "proof",
        headerNumber: proof.proof.headerNumber,
        merkleRoot: proof.proof.merkleRoot,
        merkleSiblings: proof.proof.merkleSiblings,
        continuityRoots: proof.proof.continuityRoots,
        onchainVerified: onchain?.verified ?? null,
        txIndex: proof.proof.txIndex,
        estimatedCtc: cost.estimatedCtc,
        stale: cost.stale,
        ...(decoded ? { decoded } : {}),
      },
    };
  }
  if (proof.state === "pending") {
    // G6 — the real attestation bracket, not an inference from builder 404s:
    // which bound the tx sits between + isAttested + the live attested head.
    const client = publicClient(evmChainId);
    let bounds: Awaited<ReturnType<typeof getAttestationBounds>> = null;
    if (client) {
      try {
        const tx = await client.getTransaction({ hash: args.txHash as `0x${string}` });
        if (tx?.blockNumber != null) {
          bounds = await getAttestationBounds(src.chainKey, Number(tx.blockNumber));
        }
      } catch {
        bounds = null;
      }
    }
    let height: number | null = null;
    try {
      const status = await getAttestcoinStatus();
      const chainStatus = status.chains.find((c) => c.chainKey === src.chainKey);
      height = chainStatus?.attestedHeight ?? null;
    } catch {
      /* optional context */
    }
    const boundsNote = bounds
      ? ` Tx block ${bounds.parentHeight}–${bounds.childHeight} bracket: parent is ${bounds.parentIsAttestation ? "an attestation" : "a checkpoint"} at ${bounds.parentHeight}, next bound at ${bounds.childHeight}; attested=${bounds.isAttested}.`
      : "";
    const etaNote = bounds && !bounds.isAttested ? " Attestations land every ~2 min on Ethereum-class chains." : "";
    return {
      ok: true,
      summary: `Not attested yet (proof builder: pending). Latest attested height for ${src.name}: ${height ?? "unknown"}.${boundsNote}${etaNote} Wait a few minutes and re-check.`,
      data: { state: "pending", attestedHeight: height, ...(bounds ? { bounds } : {}) },
    };
  }
  return { ok: false, summary: `Attestation check failed: ${proof.detail ?? "unknown error"}`, error: proof.state };
}

export async function execWaitForAttestation(
  args: { txHash: string; chain?: number; maxWaitSeconds: number },
  ctx: ServerToolContext,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const evmChainId = args.chain ?? 11155111;
  // G1 — live chain-key resolution before anything else.
  await ensureSourceChainMapFresh();
  const src = sourceChainByEvmId(evmChainId);
  if (!src) {
    return { ok: false, summary: `Chain ${evmChainId} is not an Attestcoin source chain this phase.`, error: "unsupported_source" };
  }
  const startedAt = Date.now();
  const maxWaitMs = Math.min(args.maxWaitSeconds, 900) * 1000;
  const deadline = startedAt + maxWaitMs;
  const waitedSeconds = () => Math.round((Date.now() - startedAt) / 1000);

  // ── G5: waitUntilHeightAttested instead of getProof polling ──────────────
  // The old loop polled getProof every 15s — each miss was an HTTP 404 against
  // the builder and attestation was only detected AFTER the builder had also
  // generated the proof (extra latency). The SDK's waitUntilHeightAttested
  // polls the cheap JSON attested-height endpoint and resolves the moment the
  // tx's block is in the builder's cache; then ONE getProof call.
  const fetchProofOnce = () => getTxProof(src.chainKey, args.txHash);

  // 1. Immediate attempt — a cached proof resolves with zero waiting.
  let proof = await fetchProofOnce();
  if (proof.state === "unknown_tx") {
    return { ok: false, summary: `Transaction ${args.txHash.slice(0, 12)}… not found on ${src.name}.`, error: "unknown_tx" };
  }

  if (proof.state !== "proof" && Date.now() < deadline) {
    // 2. Find the tx's block height on the source chain (needed to wait for
    //    the right height). Not mined yet → honest "not mined" answer.
    const client = publicClient(evmChainId);
    let targetHeight: number | null = null;
    if (client) {
      try {
        const tx = await client.getTransaction({ hash: args.txHash as `0x${string}` });
        targetHeight = tx?.blockNumber != null ? Number(tx.blockNumber) : null;
      } catch {
        targetHeight = null;
      }
    }
    if (targetHeight == null) {
      return {
        ok: false,
        summary: `Transaction ${args.txHash.slice(0, 12)}… is not mined on ${src.name} yet — nothing to attest until it lands in a block.`,
        error: "not_mined",
      };
    }

    const remainingMs = Math.max(deadline - Date.now(), 0);
    const { proofBuilderUrl } = attestcoinEndpoints();
    const builder = new proofProvider.service.ProofBuilder(src.chainKey, proofBuilderUrl);
    ctx.onProgress?.(
      `Waiting for Attestcoin attestation… (block ${targetHeight} on ${src.name}, up to ${Math.round(remainingMs / 1000)}s)`,
      "waiting_attestation",
    );
    try {
      // Poll interval 15s (SDK default), timeout = the tool's own remaining
      // budget, extraDelay covers load-balanced builder replicas (5s).
      await builder.waitUntilHeightAttested(src.chainKey, targetHeight, 15_000, remainingMs, 5_000);
    } catch {
      // Timeout inside the SDK — fall through to the final getProof check.
    }
    // 3. The height is attested + in the builder cache — one final fetch.
    proof = await fetchProofOnce();
  }

  if (proof.state === "proof" && proof.proof) {
    const summary = `Attested after ${waitedSeconds()}s: block ${proof.proof.headerNumber}, root ${proof.proof.merkleRoot.slice(0, 14)}…, ${proof.proof.continuityRoots} continuity roots. Proof is ready.`;
    return {
      ok: true,
      summary,
      data: {
        state: "proof",
        headerNumber: proof.proof.headerNumber,
        merkleRoot: proof.proof.merkleRoot,
        continuityRoots: proof.proof.continuityRoots,
        waitedSeconds: waitedSeconds(),
      },
    };
  }
  return {
    ok: false,
    summary: `Timed out after ${waitedSeconds()}s waiting for attestation (attestation lag is typically 8–10 min on Sepolia). Ask the user to try again later.`,
    error: "timeout",
  };
}

export async function execListContacts(): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  ensureDb();
  const rows = db.select().from(contacts).orderBy(desc(contacts.favorite)).all();
  const summary = rows.length > 0 ? rows.map((c) => `${c.label}: ${c.address}`).join("; ") : "No contacts saved.";
  return { ok: true, summary, data: { contacts: rows } };
}

export async function execListChains(): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const rows = CHAIN_REGISTRY.map((c) => ({
    key: c.key,
    chainId: c.chainId,
    name: c.name,
    testnet: c.testnet,
    native: c.nativeCurrency.symbol,
    tokens: c.tokens.map((t) => t.symbol),
    deployAllowed: c.deployAllowed,
    attestcoin: c.attestcoin,
  }));
  const summary = rows.map((r) => `${r.name} (${r.chainId}, ${r.testnet ? "testnet" : "mainnet"})`).join("; ");
  return { ok: true, summary, data: { chains: rows } };
}

export async function execListRecentActions(
  args: { limit: number },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  const rows = listActions(args.limit);
  const summary =
    rows.length > 0
      ? rows
          .map((r) => `${new Date(r.createdAt).toISOString().slice(5, 16)} ${r.tool} → ${r.status}${r.resultJson ? "" : ""}`)
          .join("; ")
      : "No agent actions recorded yet.";
  return {
    ok: true,
    summary,
    data: {
      actions: rows.map((r) => ({
        tool: r.tool,
        status: r.status,
        chainId: r.chainId,
        txHash: (() => {
          try {
            const parsed = JSON.parse(r.resultJson ?? "{}") as { txHash?: string };
            return parsed.txHash ?? null;
          } catch {
            return null;
          }
        })(),
        createdAt: r.createdAt,
        confirmationRequired: r.confirmationRequired,
        cc3TxHash: r.cc3TxHash,
        attestRoot: r.attestRoot,
      })),
    },
  };
}

export async function execAttestcoinNetworkStatus(): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const result = await executeAttestcoinStatus();
  if (!result.ok) return { ok: false, summary: `Attestcoin status failed: ${result.error}`, error: "status" };
  const chains = (result.chains ?? []).map((c) => `${c.name}: attested ${c.attestedHeight ?? "?"} (lag ${c.lag ?? "?"})`).join("; ");
  return { ok: true, summary: `Creditcoin block ${result.cc3Block ?? "?"}; ${chains}.`, data: result as unknown as Record<string, unknown> };
}

export async function execCreateRecurringPayment(
  args: {
    recipient: string;
    token: string;
    amount: string;
    chain: number;
    cadence: "daily" | "weekly" | "biweekly" | "monthly";
    intervalHours?: number | null;
    intervalSeconds?: number | null;
    memo: string | null;
    maxExecutions: number | null;
  },
  ctx: ServerToolContext,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  ensureDb();
  const sender = ctx.wallet?.address ?? null;
  const id = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  // C37/P17: custom intervals override the preset cadence; seconds-level
  // specs (every-<n>s) take precedence over hours. The stored value is the
  // canonical spec string parsed by cadence.ts on every fire.
  const storedCadence =
    args.intervalSeconds != null
      ? `every-${Math.floor(args.intervalSeconds)}s`
      : args.intervalHours != null
        ? `every-${Math.floor(args.intervalHours)}h`
        : args.cadence;
  const intervalMs = cadenceIntervalMs(storedCadence);
  db.insert(recurringSchedules)
    .values({
      id,
      recipientAddress: args.recipient,
      recipientLabel: args.memo?.slice(0, 60) ?? null,
      token: args.token,
      tokenAddress: null,
      amountHuman: args.amount,
      amountBaseUnits: args.amount, // resolved to base units at execution time by the client
      cadence: storedCadence,
      chainId: args.chain,
      nextFireAt: nowSec + Math.floor(intervalMs / 1000),
      executions: 0,
      maxExecutions: args.maxExecutions ?? 999,
      active: true,
      lastStatus: null,
      scheduleIdHash: id,
      senderAddress: sender,
      // P17.2: createdAt is epoch MILLISECONDS — the app-wide convention
      // (every other table writes ms). The old seconds value rendered as a
      // fake "Jan 21, 1970" date (the owner's report).
      createdAt: Date.now(),
      userId: "local",
    })
    .run();
  return {
    ok: true,
    summary: `Recurring payment scheduled (${cadenceLabelEn(storedCadence)}): ${args.amount} ${args.token} to ${args.recipient.slice(0, 12)}… on chain ${args.chain}. First execution in ${formatIntervalHuman(intervalMs)} while the app is open.`,
    data: { scheduleId: id, cadence: storedCadence, nextFireAt: nowSec + Math.floor(intervalMs / 1000) },
  };
}

export async function execGetAppStatus(
  _args: Record<string, unknown>,
  ctx: ServerToolContext,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  ensureDb();
  const wallet = ctx.wallet;
  const activeChain = wallet?.chainId ? getChainByChainId(wallet.chainId) : null;
  const recentActions = db
    .select()
    .from(agentActions)
    .orderBy(desc(agentActions.createdAt))
    .limit(5)
    .all();
  const pendingRecurring = db
    .select()
    .from(recurringSchedules)
    .where(eq(recurringSchedules.active, true))
    .all()
    .filter((r) => r.nextFireAt * 1000 <= Date.now() + 60_000).length;
  const armedRules = db.select().from(automationRules).where(eq(automationRules.active, true)).all().length;
  const contactCount = db.select().from(contacts).all().length;

  const data: Record<string, unknown> = {
    wallet: wallet?.address
      ? {
          connected: true,
          address: wallet.address,
          activeChain: { chainId: wallet.chainId, name: activeChain?.name ?? "unrecognized", testnet: activeChain?.testnet ?? null },
          holdingsKnown: Boolean(wallet.holdings && Object.keys(wallet.holdings).length > 0),
        }
      : { connected: false },
    supportedChains: CHAIN_REGISTRY.map((c) => `${c.name} (${c.chainId}${c.testnet ? ", testnet" : ", mainnet"})`),
    contacts: contactCount,
    pendingRecurring,
    armedAutomationRules: armedRules,
    recentActions: recentActions.map((a) => ({ tool: a.tool, status: a.status, chainId: a.chainId, at: a.createdAt })),
    pages: [
      "Chat (agent conversations)",
      "Actions (audit log with tx hashes and proofs)",
      "Wallet (balances, tokens, transaction history)",
      "Recurring (scheduled payments)",
      "Contacts (address book)",
      "Settings (AI provider, theme, font, skills, automation rules, deploy policy)",
    ],
  };
  const walletLine = wallet?.address
    ? `wallet ${wallet.address.slice(0, 10)}… on ${activeChain?.name ?? "chain " + String(wallet.chainId)}`
    : "no wallet connected";
  return {
    ok: true,
    summary: `App status: ${walletLine}; ${CHAIN_REGISTRY.length} supported chains; ${contactCount} contact${contactCount === 1 ? "" : "s"}; ${pendingRecurring} recurring payment${pendingRecurring === 1 ? "" : "s"} due; ${armedRules} armed rule${armedRules === 1 ? "" : "s"}; last action: ${recentActions[0] ? `${recentActions[0].tool} (${recentActions[0].status})` : "none yet"}.`,
    data,
  };
}

export function attestcoinEnvInfo(): { endpoints: ReturnType<typeof attestcoinEndpoints> } {
  return { endpoints: attestcoinEndpoints() };
}

// ── N32: direct Attestcoin protocol inspection + submission executors ────────
// All doc-grounded (see developer docs/CAPABILITY-INVENTORY.md): decode via
// the deployed EvmV1Decoder, read-only precompile verdicts, the documented
// cost model with live bounds, and submission via verifyAndEmitSingle.

interface SourceToolArgs {
  txHash: string;
  chain?: number | null;
}

interface ResolvedSource {
  evmChainId: number;
  chainKey: number;
  name: string;
}

async function resolveSourceOrError(
  args: SourceToolArgs,
): Promise<{ src: ResolvedSource } | { error: { ok: false; summary: string; error: string } }> {
  const evmChainId = args.chain ?? 11155111;
  await ensureSourceChainMapFresh();
  const src = sourceChainByEvmId(evmChainId);
  if (!src) {
    return {
      error: {
        ok: false,
        summary: `Chain ${evmChainId} is not an Attestcoin source chain. Supported sources: Sepolia (11155111) and Ethereum (1) on testnet.`,
        error: "unsupported_source",
      },
    };
  }
  return { src: { evmChainId, chainKey: src.chainKey, name: src.name } };
}

/** Common: fetch the proof; fail honestly when pending/unknown. */
async function proofOrPendingOutcome(
  chainKey: number,
  txHash: string,
  toolLabel: string,
): Promise<{ proof: NonNullable<Awaited<ReturnType<typeof getTxProof>>["raw"] & { proof: import("@/lib/attestcoin/proof").TxProof }> } | { outcome: { ok: boolean; summary: string; data?: Record<string, unknown>; error?: string } }> {
  const result = await getTxProof(chainKey, txHash);
  if (result.state === "proof" && result.proof && result.raw) {
    return { proof: { ...result.raw, proof: result.proof } };
  }
  if (result.state === "pending") {
    return {
      outcome: {
        ok: true,
        summary: `No proof yet — the block containing the tx is not attested on Creditcoin. ${toolLabel} needs a proof first: wait a few minutes (attestations land every ~2 min on Ethereum-class chains), then retry.`,
        data: { state: "pending" },
      },
    };
  }
  if (result.state === "unknown_tx") {
    return {
      outcome: {
        ok: false,
        summary: `Transaction ${txHash.slice(0, 14)}… was not found by the proof builder on the source chain.`,
        error: "unknown_tx",
      },
    };
  }
  return {
    outcome: { ok: false, summary: `Proof fetch failed: ${result.detail ?? "unknown error"}`, error: result.state },
  };
}

export async function execDecodeSourceTransaction(
  args: SourceToolArgs,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const resolved = await resolveSourceOrError(args);
  if ("error" in resolved) return resolved.error;
  const fetched = await proofOrPendingOutcome(resolved.src.chainKey, args.txHash, "Decoding");
  if ("outcome" in fetched) return fetched.outcome;

  const decoded = await decodeTxBytes(fetched.proof.txBytes, args.txHash);
  if (!decoded) {
    return {
      ok: false,
      summary: `The EvmV1Decoder on Creditcoin could not decode this transaction's bytes (unusual tx shape or decoder outage — try again shortly).`,
      error: "decode_failed",
    };
  }
  const status = decoded.receiptStatus ?? "unknown";
  const summary = `Decoded from the verified proof: type-${decoded.type} from ${decoded.from} to ${decoded.to ?? "CONTRACT CREATION"}, value ${decoded.valueEther} ETH${decoded.dataPreview ? `, calldata ${decoded.dataPreview}` : ""}, nonce ${decoded.nonce}. Receipt: ${status.toUpperCase()}${decoded.receiptGasUsed != null ? ` (${decoded.receiptGasUsed} gas)` : ""}. ${status !== "success" ? "⚠ The BlockProver proves inclusion — it does NOT check success; this receipt says the tx FAILED. Do not treat it as a valid release condition." : ""}`;
  return {
    ok: true,
    summary,
    data: { ...decoded, source: "EvmV1Decoder on Creditcoin" },
  };
}

export async function execVerifyProofReadonly(
  args: SourceToolArgs,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const resolved = await resolveSourceOrError(args);
  if ("error" in resolved) return resolved.error;
  const fetched = await proofOrPendingOutcome(resolved.src.chainKey, args.txHash, "On-chain verification");
  if ("outcome" in fetched) return fetched.outcome;

  const onchain = await verifyProofOnChain(fetched.proof);
  if (!onchain) {
    return {
      ok: false,
      summary: `Could not reach the BlockProver precompile on Creditcoin (RPC timeout) — try again shortly.`,
      error: "precompile_unreachable",
    };
  }
  const summary = onchain.verified
    ? `The Creditcoin chain itself VERIFIED the proof (read-only eth_call to the BlockProver precompile ${onchain.precompile}): tx is included in the attested block, index ${onchain.txIndex ?? "?"}. No gas was spent and no state changed.`
    : `The BlockProver precompile REJECTED this proof — the tx is not provably in an attested block (or the proof data is inconsistent).`;
  return { ok: true, summary, data: { ...onchain, mode: "read_only_eth_call" } };
}

export async function execEstimateVerificationCost(
  args: SourceToolArgs,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const resolved = await resolveSourceOrError(args);
  if ("error" in resolved) return resolved.error;
  const fetched = await proofOrPendingOutcome(resolved.src.chainKey, args.txHash, "Cost estimation");
  if ("outcome" in fetched) return fetched.outcome;

  const attestedHeight = await getAttestcoinStatus()
    .then((s) => s.chains.find((c) => c.chainKey === resolved.src.chainKey)?.attestedHeight ?? null)
    .catch(() => null);
  const cost = proofCostContext(fetched.proof.proof, attestedHeight);
  const bounds = await getAttestationBounds(resolved.src.chainKey, fetched.proof.headerNumber).catch(() => null);
  const summary = `Estimated on-chain verification cost: ${cost.ctcLabel} (continuity proof: ${cost.continuityRoots} roots${bounds ? `; bounds ${bounds.parentHeight}–${bounds.childHeight}, ${bounds.parentIsAttestation ? "attestation" : "checkpoint"}-anchored` : ""}).${cost.stale ? ` STALE proof — the tx is ${cost.staleGapBlocks} blocks behind the attested head; waiting longer only makes it pricier.` : " Fresh proof — verifying soon after finalization keeps the continuity chain short."} Docs guidance: recent txs cost 10–100x less than day-old ones; submitting a ~10-min-old tx ≈ 2.6e-5 CTC, a day-old one ≈ 3.1e-4 CTC.`;
  return { ok: true, summary, data: { ...cost, ...(bounds ? { bounds } : {}) } };
}

export async function execGetAttestationBoundsTool(
  args: SourceToolArgs,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const resolved = await resolveSourceOrError(args);
  if ("error" in resolved) return resolved.error;

  // Resolve the tx's block height — from the proof when it exists, else the
  // source-chain RPC.
  let height: number | null = null;
  const fetched = await getTxProof(resolved.src.chainKey, args.txHash);
  if (fetched.state === "proof" && fetched.proof) {
    height = fetched.proof.headerNumber;
  } else {
    const client = publicClient(resolved.src.evmChainId);
    if (client) {
      try {
        const tx = await client.getTransaction({ hash: args.txHash as `0x${string}` });
        height = tx?.blockNumber != null ? Number(tx.blockNumber) : null;
      } catch {
        height = null;
      }
    }
  }
  if (height == null) {
    return {
      ok: false,
      summary: `Transaction ${args.txHash.slice(0, 14)}… is not mined on ${resolved.src.name} yet — there are no attestation bounds until it lands in a block.`,
      error: "not_mined",
    };
  }

  const bounds = await getAttestationBounds(resolved.src.chainKey, height);
  if (!bounds) {
    return { ok: false, summary: `Could not read attestation bounds from the ChainInfo precompile (RPC timeout).`, error: "bounds_unavailable" };
  }
  const summary = `Block ${height} sits in the bracket [${bounds.parentHeight} (${bounds.parentIsAttestation ? "attestation" : "checkpoint"}), ${bounds.childHeight} (${bounds.childIsAttestation ? "attestation" : "checkpoint"})]. This block: attested=${bounds.isAttested}. ${bounds.isAttested ? "A proof can be generated now." : "The bracket advances as attestors consensus lands new bounds — typically minutes."}`;
  return { ok: true, summary, data: { height, ...bounds } };
}

export async function execSubmitProofOnchain(
  args: SourceToolArgs,
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  const resolved = await resolveSourceOrError(args);
  if ("error" in resolved) return resolved.error;

  // N27 human-intervention transparency: the signer key is the one thing this
  // tool cannot work without — say exactly what is needed and where it goes.
  const availability = submissionAvailability();
  if (!availability.configured) {
    return {
      ok: false,
      summary: `On-chain proof submission is not available in this deployment: the app's Attestcoin submission key (${availability.requiredEnv}) is not configured. What to do: the operator sets ${availability.requiredEnv} in the app's environment (.env) to a funded Creditcoin ${attestcoinEnv() === "testnet" ? "Testnet" : "Mainnet"} account key, then restarts the app. Read-only verification (verify_proof_readonly) works without it and gives the same chain verdict without spending gas.`,
      error: "submission_not_configured",
    };
  }

  const fetched = await proofOrPendingOutcome(resolved.src.chainKey, args.txHash, "Submission");
  if ("outcome" in fetched) return fetched.outcome;

  const result = await submitProofOnChain(fetched.proof);
  if (!result.ok) {
    return { ok: false, summary: `On-chain submission failed: ${result.detail ?? "unknown error"}. The proof itself is valid (a read-only check with verify_proof_readonly can confirm); the failure was in the submission transaction.`, error: "submission_failed", data: { detail: result.detail ?? null } };
  }
  const event = result.event ? `TransactionVerified(chainKey ${result.event.chainKey}, height ${result.event.height}, index ${result.event.transactionIndex})` : "the TransactionVerified event";
  // N27.1: deep link to the CC3 Blockscout tx page (registry-truth URL),
  // dashboard kept as the ecosystem context link.
  const cc3TxUrl = result.cc3TxHash ? cc3ExplorerTxUrl(attestcoinEnv(), result.cc3TxHash) : null;
  const summary = `Submitted on-chain: Creditcoin tx ${result.cc3TxHash ?? "(hash unavailable)"} emitted ${event}${result.gasUsed != null ? `, ${result.gasUsed} gas (${result.gasPctOfBlock != null ? result.gasPctOfBlock.toFixed(2) + "% of the block" : "?"})` : ""}. The source tx is now ON-CHAIN verified on Creditcoin ${attestcoinEnv() === "testnet" ? "Testnet" : "Mainnet"}${cc3TxUrl ? ` — view it at ${cc3TxUrl}` : ` — visible at ${attestcoinEndpoints().dashboardUrl}`}.`;
  return {
    ok: true,
    summary,
    data: { ...result, explorerTx: cc3TxUrl, dashboardUrl: attestcoinEndpoints().dashboardUrl, signerAddress: availability.signerAddress },
  };
}

// ── N24: app-control executors (contacts + recurring schedule management) ────

export async function execCreateContact(
  args: { label: string; address: string; note?: string | null },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  ensureDb();
  const validated = validateCreateContact({ label: args.label, address: args.address, note: args.note ?? null });
  if (!validated.ok) return { ok: false, summary: validated.error, error: "invalid_contact" };
  // Case-insensitive duplicate guard (mirrors the /api/contacts route).
  const duplicate = db
    .select()
    .from(contacts)
    .where(sql`lower(${contacts.address}) = ${validated.data.address.toLowerCase()}`)
    .get();
  if (duplicate) {
    return {
      ok: false,
      summary: `That address is already saved as "${duplicate.label}". Use the existing contact (or rename it on the Contacts page) — the address book never stores the same address twice.`,
      error: "duplicate",
      data: { existingLabel: duplicate.label },
    };
  }
  db.insert(contacts).values(validated.data).run();
  return {
    ok: true,
    summary: `Saved "${validated.data.label}" to Contacts${validated.data.note ? ` (note: ${validated.data.note})` : ""}. Future payments can use the name directly.`,
    data: { contactId: validated.data.id },
  };
}

export async function execListRecurringPayments(
  args: { includeInactive?: boolean | null },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  ensureDb();
  const rows = db
    .select()
    .from(recurringSchedules)
    .orderBy(desc(recurringSchedules.createdAt))
    .all();
  const filtered = args.includeInactive === true ? rows : rows.filter((r) => r.active);
  const nowSec = Math.floor(Date.now() / 1000);

  // Humanized wait text (D12): "~642688h" is meaningless to anyone. Below ~2
  // days use the natural unit; beyond that, a calendar date beats hour soup.
  const waitText = (fireAt: number): string => {
    if (fireAt <= nowSec) return "due now (runs at next app open)";
    const s = fireAt - nowSec;
    if (s < 90 * 60) return `in ~${Math.max(1, Math.round(s / 60))}m`;
    if (s < 48 * 3600) return `in ~${Math.round(s / 3600)}h`;
    if (s < 60 * 86400) return `in ~${Math.round(s / 86400)}d`;
    return `on ${new Date(fireAt * 1000).toISOString().slice(0, 10)}`;
  };

  const formatted = filtered.map((r) => ({
    scheduleId: r.id,
    recipient: r.recipientLabel ? `${r.recipientLabel} (${r.recipientAddress})` : r.recipientAddress,
    amount: `${r.amountHuman} ${r.token}`,
    chainId: r.chainId,
    cadence: cadenceLabelEn(String(r.cadence)),
    nextExecution: r.active ? waitText(r.nextFireAt) : null,
    executions: `${r.executions}/${r.maxExecutions}`,
    active: r.active,
    lastStatus: r.lastStatus ?? null,
  }));
  const summary =
    formatted.length === 0
      ? args.includeInactive === true
        ? "No recurring payment schedules exist."
        : "No active recurring payments. (Pass includeInactive to see completed/cancelled ones.)"
      : formatted
          // D12: the scheduleId LEADS, in brackets — a model copying from the
          // summary grabs a clean id, not a whole prose line (live-observed
          // failure: the trailing `id …` form fed a 100-char string into
          // cancel_recurring_payment's 64-char schema).
          .map((r) => `[${r.scheduleId}] ${r.amount} ${r.cadence} → ${r.recipient} (chain ${r.chainId ?? "?"}, ${r.executions} runs, ${r.active ? r.nextExecution : "inactive"})`)
          .join("; ");
  return { ok: true, summary, data: { schedules: formatted } };
}

export async function execCancelRecurringPayment(
  args: { scheduleId: string },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  ensureDb();
  const row = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, args.scheduleId)).all()[0];
  if (!row) {
    return { ok: false, summary: "No recurring schedule with that id exists — call list_recurring_payments to see the current ids.", error: "not_found" };
  }
  if (!row.active) {
    return { ok: false, summary: `That schedule is already inactive (${row.executions}/${row.maxExecutions} executed${row.lastStatus ? `, last status: ${row.lastStatus}` : ""}). Nothing to cancel.`, error: "already_inactive" };
  }
  db.update(recurringSchedules)
    .set({ active: false, lastStatus: "cancelled" })
    .where(and(eq(recurringSchedules.id, row.id), eq(recurringSchedules.active, true)))
    .run();
  return {
    ok: true,
    summary: `Cancelled the ${cadenceLabelEn(String(row.cadence))} payment of ${row.amountHuman} ${row.token} to ${row.recipientLabel ?? row.recipientAddress} (chain ${row.chainId}). ${row.executions} execution${row.executions === 1 ? "" : "s"} had already run — those are untouched. No funds move from this cancellation.`,
    data: { scheduleId: row.id, cancelledAt: Date.now() },
  };
}


// ── P20: automation-rule executors (server-side CRUD; schema-validated,
// logged by the loop's start/patch machinery like every tool call) ─────────

function automationRuleSummary(rule: {
  id: string;
  name: string;
  triggerType: string;
  triggerConfigJson: string;
  actionJson: string;
  active: boolean;
  lastFiredAt: number | null;
  lastStatus: string | null;
  createdAt: number;
}): string {
  let trigger = "unknown";
  try {
    const cfg = JSON.parse(rule.triggerConfigJson) as Record<string, unknown>;
    if (rule.triggerType === "schedule") trigger = `every ${String(cfg.everyMinutes ?? "?")} minutes`;
    else if (rule.triggerType === "attestation_ready") trigger = `attestation of payment ${String(cfg.paymentId ?? "?").slice(0, 10)}…`;
    else trigger = `${rule.triggerType === "balance_above" ? "balance ≥" : "balance ≤"} ${String(cfg.threshold ?? "?")} ${String(cfg.token ?? "")} on chain ${String(cfg.chainId ?? "?")}`;
  } catch {
    /* unparsable — keep 'unknown' */
  }
  let actionTxt = "unknown";
  try {
    const action = JSON.parse(rule.actionJson) as AutomationActionConfig;
    if (action.kind === "notify") actionTxt = `notify: ${action.message.slice(0, 60)}`;
    else actionTxt = `transfer ${action.amount} ${action.token} to ${action.recipient.slice(0, 12)}… on chain ${action.chainId}`;
  } catch {
    /* unparsable */
  }
  return `[${rule.id}] "${rule.name}" — ${trigger} → ${actionTxt} (${rule.active ? "armed" : "disarmed"}, last fired: ${rule.lastFiredAt ? new Date(rule.lastFiredAt).toISOString().slice(0, 16).replace("T", " ") : "never"})`;
}

export async function execCreateAutomationRule(
  args: { name: string; triggerType: string; triggerConfig: Record<string, unknown>; action: Record<string, unknown> },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  ensureDb();
  const name = args.name.trim();
  if (name.length < 2 || name.length > 60) {
    return { ok: false, summary: "Rule name must be 2-60 characters.", error: "invalid_args" };
  }
  if (!isTriggerType(args.triggerType)) {
    return { ok: false, summary: "triggerType must be one of balance_above | balance_below | attestation_ready | schedule.", error: "invalid_args" };
  }
  const trigger = validateTriggerConfig(args.triggerType, args.triggerConfig);
  if (!trigger.ok) return { ok: false, summary: trigger.error, error: "invalid_args" };
  const action = validateAction(args.action);
  if (!action.ok) return { ok: false, summary: action.error, error: "invalid_args" };
  if (args.triggerType === "attestation_ready") {
    const paymentId = (trigger.value as { paymentId: string }).paymentId;
    const exists = db.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!exists) {
      return { ok: false, summary: "No payment with that id exists — the rule could never fire. Check the payment id (see /payments).", error: "not_found" };
    }
  }
  const count = db.select({ id: automationRules.id }).from(automationRules).all().length;
  if (count >= AUTOMATION_RULE_CAP) {
    return { ok: false, summary: `Automation rule limit reached (${AUTOMATION_RULE_CAP}). Delete a rule first.`, error: "cap" };
  }
  const id = randomUUID();
  db.insert(automationRules)
    .values({
      id,
      name,
      triggerType: args.triggerType,
      triggerConfigJson: JSON.stringify(trigger.value),
      actionJson: JSON.stringify(action.value),
      active: true,
      createdAt: Date.now(),
    })
    .run();
  const row = db.select().from(automationRules).where(eq(automationRules.id, id)).all()[0];
  return {
    ok: true,
    summary: `Automation rule "${name}" created and armed: ${automationRuleSummary(row)}. It evaluates while the app is open${action.value.kind === "transfer" ? " — each firing transfer still asks for the wallet signature" : ""}.`,
    data: { ruleId: id, rule: serializeRule(row) },
  };
}

export async function execUpdateAutomationRule(
  args: {
    ruleId: string;
    name?: string | null;
    active?: boolean | null;
    triggerType?: string | null;
    triggerConfig?: Record<string, unknown> | null;
    action?: Record<string, unknown> | null;
  },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  ensureDb();
  const row = db.select().from(automationRules).where(eq(automationRules.id, args.ruleId)).all()[0];
  if (!row) {
    return { ok: false, summary: "No automation rule with that id exists — call list_automation_rules to see the current ids.", error: "not_found" };
  }
  const set: Record<string, unknown> = {};
  if (args.name != null) {
    const name = args.name.trim();
    if (name.length < 2 || name.length > 60) return { ok: false, summary: "Rule name must be 2-60 characters.", error: "invalid_args" };
    set.name = name;
  }
  if (args.active != null) set.active = args.active;
  if (args.triggerType != null || args.triggerConfig != null) {
    const nextType = args.triggerType ?? row.triggerType;
    if (!isTriggerType(nextType)) {
      return { ok: false, summary: "triggerType must be one of balance_above | balance_below | attestation_ready | schedule.", error: "invalid_args" };
    }
    const nextCfgRaw = args.triggerConfig ?? JSON.parse(row.triggerConfigJson);
    const trigger = validateTriggerConfig(nextType, nextCfgRaw);
    if (!trigger.ok) return { ok: false, summary: trigger.error, error: "invalid_args" };
    if (nextType === "attestation_ready") {
      const paymentId = (trigger.value as { paymentId: string }).paymentId;
      const exists = db.select().from(payments).where(eq(payments.id, paymentId)).get();
      if (!exists) return { ok: false, summary: "No payment with that id exists — the rule could never fire.", error: "not_found" };
    }
    set.triggerType = nextType;
    set.triggerConfigJson = JSON.stringify(trigger.value);
    set.lastFiredAt = null;
    set.lastStatus = null;
  }
  if (args.action != null) {
    const action = validateAction(args.action);
    if (!action.ok) return { ok: false, summary: action.error, error: "invalid_args" };
    set.actionJson = JSON.stringify(action.value);
  }
  if (Object.keys(set).length === 0) {
    return { ok: false, summary: "Nothing to update — provide name, active, triggerType/triggerConfig, or action.", error: "invalid_args" };
  }
  db.update(automationRules).set(set).where(eq(automationRules.id, row.id)).run();
  const updated = db.select().from(automationRules).where(eq(automationRules.id, row.id)).all()[0];
  return {
    ok: true,
    summary: `Rule updated: ${automationRuleSummary(updated)}.`,
    data: { ruleId: row.id, rule: serializeRule(updated) },
  };
}

export async function execDeleteAutomationRule(
  args: { ruleId: string },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown>; error?: string }> {
  ensureDb();
  const row = db.select().from(automationRules).where(eq(automationRules.id, args.ruleId)).all()[0];
  if (!row) {
    return { ok: false, summary: "No automation rule with that id exists — call list_automation_rules to see the current ids.", error: "not_found" };
  }
  db.delete(automationRules).where(eq(automationRules.id, row.id)).run();
  return {
    ok: true,
    summary: `Automation rule "${row.name}" deleted permanently. Its queued-but-unexecuted firings are gone; nothing else is affected (no funds move from a deletion).`,
    data: { ruleId: row.id, deleted: true },
  };
}

export async function execListAutomationRules(
  args: { includeInactive?: boolean | null },
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  ensureDb();
  const rows = db.select().from(automationRules).orderBy(desc(automationRules.createdAt)).all();
  const filtered = args.includeInactive === true ? rows : rows.filter((r) => r.active);
  const summary =
    filtered.length === 0
      ? args.includeInactive === true
        ? "No automation rules exist."
        : "No armed automation rules. (Pass includeInactive to see disarmed ones.)"
      : filtered.map(automationRuleSummary).join("; ");
  return { ok: true, summary, data: { rules: filtered.map((r) => serializeRule(r)) } };
}