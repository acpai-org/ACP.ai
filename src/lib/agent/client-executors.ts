"use client";

import { erc20Abi, formatGwei, getContractAddress, parseUnits, type Address, type Hash, type WalletClient } from "viem";
import { createPublicClient, http, type PublicClient } from "viem";
import { getChainByChainId, VIEM_CHAINS } from "@/lib/chains/registry";
import { recordTxEvent } from "@/lib/agent/tx-lifecycle";
import type { ToolClientResult, TraceStepDetail } from "@/lib/agent/events";

/** Fire-and-forget: bump a saved contact's lastUsed after a confirmed send. */
function markContactUsed(recipient: string): void {
  try {
    void fetch("/api/contacts/used", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: recipient }),
    }).catch(() => {});
  } catch {
    // best-effort only — never blocks the tool result
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE tool executors — the wallet half of the agent (brief §2).
//
// The server loop dispatches tool_call_request events here; the browser turns
// each validated intent into a SPECIFIC known transaction shape via the wagmi
// wallet client (never arbitrary calldata from the model):
//   transfer        → sendTransaction (native) | writeContract transfer (ERC-20)
//   batch_transfer  → sequential transfers
//   deploy_contract → deployContract with server-compiled bytecode
//   create_conditional_release → deploy + escrow-value in one tx
//   execute_conditional_release / swap release → writeContract release(...)
//
// Chain auto-switching (brief §3): every executor ensures the wallet is on the
// tool's target chain first — switchChain is silent wherever the wallet
// supports it (pre-added chains; WC session namespaces).
// ─────────────────────────────────────────────────────────────────────────────

export type ProgressFn = (detail: TraceStepDetail, status?: "awaiting_signature" | "broadcast" | "confirming" | "succeeded") => void;

export interface ExecutorWallet {
  address: Address | undefined;
  walletClient: WalletClient | null | undefined;
  switchChain: (args: { chainId: number }) => Promise<unknown>;
  isConnected: boolean;
}

function err(e: unknown): { message: string; code?: string } {
  if (e instanceof Error) {
    const msg = e.message;
    const code = /user rejected|rejected the request|denied/i.test(msg)
      ? "user_rejected"
      : /insufficient funds/i.test(msg)
        ? "insufficient_funds"
        : /\b(429|rate.?limit|timeout|timed out|ECONNREFUSED|ECONNRESET|network|fetch failed|socket hang up|socket\.connect)\b/i.test(msg)
          ? "transient_error"
          : undefined;
    return { message: msg, code };
  }
  return { message: String(e) };
}

function publicClientFor(chainId: number) {
  const chain = getChainByChainId(chainId);
  return createPublicClient({ chain: VIEM_CHAINS[chainId], transport: http(chain?.rpcUrls[0] ?? "", { timeout: 15_000 }) });
}

// ── Receipt waiting (the "keep fetching until it lands" contract) ────────────
// A broadcast tx is polled ACTIVELY for the whole in-run budget — the loop's
// tool-result cap is 10 min, so the waiter runs just under it (9 min) — with
// live progress beats so the trace stays honest during the wait. Beyond that
// budget the status is still UNKNOWN, so trackUnknownTx keeps polling in the
// background for a full day and flips the action log when the receipt lands.
const RECEIPT_POLL_MS = 5_000;
const RECEIPT_PROGRESS_EVERY_MS = 30_000;
/** Just under the loop's TOOL_RESULT_TIMEOUT_MS (10 min) so the in-run wait
 * exhausts the tool budget, never the loop's patience. */
const RECEIPT_WAIT_MS = 9 * 60_000;
const BACKGROUND_TRACK_MS = 24 * 60 * 60_000;
const BACKGROUND_TRACK_INTERVAL_MS = 20_000;

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Why a tx is still pending, read off the chain (never guessed): the #1 real
 * cause is a max fee below the current base fee — the tx sits in the mempool
 * until the base fee decays below its ceiling (or the user speeds it up). */
async function pendingReasonNote(client: PublicClient, hash: Hash): Promise<string> {
  try {
    const [tx, block] = await Promise.all([
      client.getTransaction({ hash }),
      client.getBlock({ blockTag: "latest" }),
    ]);
    const maxFee = tx?.maxFeePerGas;
    const base = block?.baseFeePerGas;
    if (maxFee != null && base != null && maxFee < base) {
      return ` Its max fee (${formatGwei(maxFee)} gwei) is below the current network base fee (${formatGwei(base)} gwei), so it is queued in the mempool — it will mine when the base fee drops, or you can speed it up from your wallet.`;
    }
    return " The transaction is visible in the mempool — waiting for a miner.";
  } catch {
    return "";
  }
}

/**
 * Poll for the receipt ACTIVELY until it arrives or the in-run budget is
 * exhausted. A budget exhaustion is NOT a failure — the tx was broadcast and
 * its status stays UNKNOWN (hard boundary 7: never auto-resend); the caller
 * starts a background tracker (trackUnknownTx) that keeps fetching.
 */
async function waitForTx(
  chainId: number,
  hash: Hash,
  onProgress?: (text: string) => void,
): Promise<{ status: "success" | "reverted" | "receipt_timeout"; blockNumber: bigint }> {
  const client = publicClientFor(chainId);
  const startedAt = Date.now();
  let lastProgressAt = 0;
  for (;;) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      return { status: receipt.status === "success" ? "success" : "reverted", blockNumber: receipt.blockNumber };
    } catch {
      /* not mined yet — keep polling */
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= RECEIPT_WAIT_MS) {
      // Receipt didn't arrive within the window (RPC outage, extreme congestion,
      // or an unknown chain-side delay). The transaction WAS broadcast — its
      // status is UNKNOWN, never "failed". Hard boundary 7: the caller must
      // surface this as unknown and NEVER resend. blockNumber is meaningless
      // here (0 sentinel).
      return { status: "receipt_timeout", blockNumber: 0n };
    }
    if (onProgress && elapsed - lastProgressAt >= RECEIPT_PROGRESS_EVERY_MS) {
      lastProgressAt = elapsed;
      const note = await pendingReasonNote(client, hash);
      onProgress(`Still waiting for the receipt… ${fmtElapsed(elapsed)}.${note}`);
    }
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_MS));
  }
}

/**
 * Detached post-run tracker for a broadcast-but-unconfirmed tx (§4.6 "the log
 * catches up from the receipt"). Polls in the background for up to 24h; when
 * the receipt lands it updates the live lifecycle store AND the persistent
 * action-log row (via a terminal tool_status POST carrying the final result).
 * Fire-and-forget: it must never block or reject.
 */
export function trackUnknownTx(opts: {
  callId: string;
  sessionId: string;
  chainId: number;
  txHash: Hash;
  what: string;
}): void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      try {
        const receipt = await publicClientFor(opts.chainId).getTransactionReceipt({ hash: opts.txHash });
        const ok = receipt.status === "success";
        const summary = `Receipt for the ${opts.what} transaction ${opts.txHash.slice(0, 14)}… landed in block ${receipt.blockNumber}: ${ok ? "SUCCESS" : "REVERTED"}. The earlier "status unknown" is now resolved.`;
        clearInterval(timer);
        recordTxEvent(opts.callId, opts.sessionId, {
          status: ok ? "confirmed" : "failed",
          txHash: opts.txHash,
          chainId: opts.chainId,
          blockNumber: Number(receipt.blockNumber),
          ...(ok ? {} : { error: "reverted" }),
        });
        void fetch("/api/agent/respond", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: opts.sessionId,
            callId: opts.callId,
            kind: "tool_status",
            status: ok ? "confirmed" : "failed",
            txHash: opts.txHash,
            chainId: opts.chainId,
            blockNumber: Number(receipt.blockNumber),
            result: { ok, summary, txHash: opts.txHash, chainId: opts.chainId },
          }),
        }).catch(() => {});
      } catch {
        /* still no receipt — keep polling until the cap */
      }
      if (Date.now() - startedAt >= BACKGROUND_TRACK_MS) clearInterval(timer);
    })();
  }, BACKGROUND_TRACK_INTERVAL_MS);
}

/**
 * EIP-1559 fee data computed from the chain's own latest block — protects
 * agent-initiated sends from the wallet's stale/optimistic fee estimate
 * (a max fee under the base fee strands the tx as pending forever). 2× base
 * headroom + the node's suggested tip; on ANY failure the wallet's own
 * estimate is used (empty override — honest fallback, no invented numbers).
 */
async function feeOverridesFor(chainId: number): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  try {
    const client = publicClientFor(chainId);
    const block = await client.getBlock({ blockTag: "latest" });
    const base = block?.baseFeePerGas;
    if (typeof base !== "bigint" || base <= 0n) return {};
    let tip = 2n * 10n ** 9n; // 2 gwei floor
    try {
      const suggested = (await client.request({ method: "eth_maxPriorityFeePerGas" })) as string;
      const parsed = BigInt(suggested);
      if (parsed > tip) tip = parsed <= 200n * 10n ** 9n ? parsed : 200n * 10n ** 9n;
    } catch {
      /* node doesn't serve the method — keep the 2 gwei floor */
    }
    return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
  } catch {
    return {};
  }
}

async function ensureChain(w: ExecutorWallet, chainId: number, onChainSwitched?: (name: string) => void): Promise<void> {
  if (!w.walletClient) throw new Error("Wallet not connected");
  // P7/P14 fix: read the wallet's ACTUAL current chain (eth_chainId) — the
  // client's cached `chain` field can be stale after external switches.
  const actual = await w.walletClient.getChainId().catch(() => null);
  if (actual === chainId) return;
  const chain = getChainByChainId(chainId);
  if (!chain) throw new Error(`Unsupported chain ${chainId}.`);
  onChainSwitched?.(chain.name);
  // switchChainAsync is awaited (see use-agent-run.ts) — the switch is real
  // before the first signature request.
  await w.switchChain({ chainId });
  // Verify the switch actually happened — some wallets silently ignore
  // switches for chains they don't know. NEVER proceed on the wrong chain:
  // abort with an honest, actionable error (nothing signed, nothing moved).
  const after = await w.walletClient.getChainId().catch(() => null);
  if (after !== chainId) {
    throw new Error(
      `The wallet did not switch to ${chain.name} (still on chain ${after ?? "unknown"}). Nothing was sent — no signature was requested and no funds moved. Add or select ${chain.name} in your wallet, then try again.`,
    );
  }
}

/** Honest "state unknown" result for a broadcast-but-unconfirmed tx. */
function receiptTimeoutResult(chainId: number, hash: Hash, what: string): ToolClientResult {
  const chain = getChainByChainId(chainId);
  const url = chain?.explorerUrl ? `${chain.explorerUrl}/tx/${hash}` : undefined;
  return {
    ok: false,
    summary: `The ${what} transaction was broadcast (${hash.slice(0, 16)}…) and was still unconfirmed after 9 minutes of continuous receipt polling on ${chain?.name ?? `chain ${chainId}`}. Its status is UNKNOWN — do NOT resend it (double-spend risk). Background tracking keeps checking; re-check later with get_transaction_status${url ? ` or the explorer: ${url}` : ""}, and tell the user honestly.`,
    txHash: hash,
    chainId,
    error: "receipt_timeout",
    ...(url ? { data: { explorerUrl: url } } : {}),
  };
}

function explorerTx(chainId: number, hash: string): string | undefined {
  const chain = getChainByChainId(chainId);
  return chain?.explorerUrl ? `${chain.explorerUrl}/tx/${hash}` : undefined;
}

function resolveToken(chainId: number, token: string): { address: Address | null; decimals: number; symbol: string } {
  const chain = getChainByChainId(chainId);
  if (!chain) return { address: null, decimals: 18, symbol: token };
  const sym = token.toUpperCase();
  if (sym === chain.nativeCurrency.symbol.toUpperCase()) {
    return { address: null, decimals: chain.nativeCurrency.decimals, symbol: chain.nativeCurrency.symbol };
  }
  const known = chain.tokens.find((t) => t.symbol.toUpperCase() === sym);
  if (known) return { address: known.address, decimals: known.decimals, symbol: known.symbol };
  if (/^0x[a-fA-F0-9]{40}$/.test(token)) {
    return { address: token as Address, decimals: 18, symbol: token.slice(0, 8) + "…" }; // unknown decimals — probed below
  }
  throw new Error(`Unknown token "${token}" on ${chain.name}. Provide a 0x contract address or a known symbol.`);
}

// ── transfer ─────────────────────────────────────────────────────────────────

export async function execTransfer(
  w: ExecutorWallet,
  args: { chain: number; recipient: string; token: string; amount: string; memo?: string | null },
  progress: ProgressFn,
): Promise<ToolClientResult> {
  try {
    if (!w.address) return { ok: false, summary: "Wallet not connected — this is TERMINAL: do not retry the transfer, ask the user to connect a wallet first.", error: "no_wallet" };
    await ensureChain(w, args.chain, (name) => progress({ text: `Switching to ${name}…` }));
    const chain = getChainByChainId(args.chain)!;
    let token = resolveToken(args.chain, args.token);

    // Probe real decimals for ad-hoc token addresses.
    if (token.address && token.symbol.includes("…")) {
      try {
        const client = publicClientFor(args.chain);
        const [decimals, symbol] = await Promise.all([
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
        ]);
        token = { ...token, decimals, symbol };
      } catch {
        return { ok: false, summary: `Could not read token contract ${args.token} on ${chain.name}.`, error: "bad_token" };
      }
    }

    const amountBase = parseUnits(args.amount, token.decimals);
    progress({ text: `Sign the ${args.amount} ${token.symbol} transfer in your wallet…`, chainId: args.chain }, "awaiting_signature");

    let hash: Hash;
    if (!token.address) {
      // P7/P14: explicit `chain` — viem asserts the wallet's current chain
      // matches before requesting the signature (no tx can silently land on
      // another chain). Fee overrides keep the max fee above the base fee so
      // the tx can't strand as pending (the wallet's own estimate is the fallback).
      hash = (await w.walletClient!.sendTransaction({
        to: args.recipient as Address,
        value: amountBase,
        chain: VIEM_CHAINS[args.chain] ?? null,
        account: w.address!,
        ...(await feeOverridesFor(args.chain)),
      })) as Hash;
    } else {
      hash = (await w.walletClient!.writeContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [args.recipient as Address, amountBase],
        chain: VIEM_CHAINS[args.chain] ?? null,
        account: w.address!,
        ...(await feeOverridesFor(args.chain)),
      })) as Hash;
    }

    progress({ text: "Broadcast — waiting for the receipt…", txHash: hash, chainId: args.chain }, "broadcast");
    const receipt = await waitForTx(args.chain, hash, (text) =>
      progress({ text, txHash: hash, chainId: args.chain }, "confirming"),
    );
    if (receipt.status === "receipt_timeout") {
      return receiptTimeoutResult(args.chain, hash, "transfer");
    }
    if (receipt.status !== "success") {
      return {
        ok: false,
        summary: `Transaction reverted on ${chain.name} (tx ${hash.slice(0, 14)}…).`,
        txHash: hash,
        chainId: args.chain,
        error: "reverted",
      };
    }
    progress({ text: `Confirmed in block ${receipt.blockNumber}`, txHash: hash, chainId: args.chain }, "succeeded");
    markContactUsed(args.recipient);
    return {
      ok: true,
      summary: `Sent ${args.amount} ${token.symbol} to ${args.recipient.slice(0, 10)}… on ${chain.name} (block ${receipt.blockNumber}).`,
      txHash: hash,
      chainId: args.chain,
      data: { explorerUrl: explorerTx(args.chain, hash), token: token.symbol, recipient: args.recipient, amount: args.amount },
    };
  } catch (e) {
    const { message, code } = err(e);
    return { ok: false, summary: code === "user_rejected" ? "You rejected the signature in the wallet." : `Transfer failed: ${message}`, error: code ?? "transfer_failed" };
  }
}

// ── batch_transfer ───────────────────────────────────────────────────────────

export async function execBatchTransfer(
  w: ExecutorWallet,
  args: { chain: number; transfers: Array<{ recipient: string; token: string; amount: string; memo?: string | null }> },
  progress: ProgressFn,
): Promise<ToolClientResult> {
  if (!w.address) return { ok: false, summary: "Wallet not connected — this is TERMINAL: do not retry the transfer, ask the user to connect a wallet first.", error: "no_wallet" };
  const chain = getChainByChainId(args.chain);
  if (!chain) return { ok: false, summary: `Unsupported chain ${args.chain}.`, error: "bad_chain" };

  await ensureChain(w, args.chain, (name) => progress({ text: `Switching to ${name}…` }));

  const results: Array<{ recipient: string; ok: boolean; txHash?: string; summary: string }> = [];
  const tokenCache = new Map<string, { address: Address | null; decimals: number; symbol: string }>();
  let firstHash: string | undefined;
  let succeeded = 0;

  for (let i = 0; i < args.transfers.length; i++) {
    const t = args.transfers[i];
    try {
      let token = tokenCache.get(t.token) ?? resolveToken(args.chain, t.token);
      if (token.address && token.symbol.includes("…")) {
        const client = publicClientFor(args.chain);
        const [decimals, symbol] = await Promise.all([
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
          client.readContract({ address: token.address, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
        ]);
        token = { ...token, decimals, symbol };
      }
      tokenCache.set(t.token, token);

      progress({ text: `Transfer ${i + 1}/${args.transfers.length}: sign ${t.amount} ${token.symbol}…` }, "awaiting_signature");
      const amountBase = parseUnits(t.amount, token.decimals);
      let hash: Hash;
      if (!token.address) {
        hash = (await w.walletClient!.sendTransaction({
          to: t.recipient as Address,
          value: amountBase,
          chain: VIEM_CHAINS[args.chain] ?? null,
          account: w.address!,
          ...(await feeOverridesFor(args.chain)),
        })) as Hash;
      } else {
        hash = (await w.walletClient!.writeContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [t.recipient as Address, amountBase],
          chain: VIEM_CHAINS[args.chain] ?? null,
          account: w.address!,
          ...(await feeOverridesFor(args.chain)),
        })) as Hash;
      }
      if (!firstHash) firstHash = hash;
      progress({ text: `Transfer ${i + 1}: waiting for receipt…`, txHash: hash, chainId: args.chain }, "broadcast");
      const receipt = await waitForTx(args.chain, hash, (text) =>
        progress({ text, txHash: hash, chainId: args.chain }, "confirming"),
      );
      if (receipt.status === "receipt_timeout") {
        // Unknown state — stop the batch, surface honestly, never resend.
        results.push({ recipient: t.recipient, ok: false, txHash: hash, summary: "broadcast but receipt not yet available (status unknown)" });
        return {
          ok: false,
          summary: `Transfer ${i + 1} was broadcast but its receipt has not arrived (status UNKNOWN — do NOT resend). ${succeeded} transfers completed before it. Check tx ${hash.slice(0, 16)}… with get_transaction_status later.`,
          txHash: firstHash ?? hash,
          chainId: args.chain,
          error: "receipt_timeout",
          data: { partial: results },
        };
      }
      const ok = receipt.status === "success";
      if (ok) {
        succeeded++;
        markContactUsed(t.recipient);
      }
      results.push({
        recipient: t.recipient,
        ok,
        txHash: hash,
        summary: ok ? `confirmed (block ${receipt.blockNumber})` : "reverted",
      });
    } catch (e) {
      const { message, code } = err(e);
      results.push({ recipient: t.recipient, ok: false, summary: code === "user_rejected" ? "signature rejected" : message });
      if (code === "user_rejected") {
        // Stop the batch on rejection — continuing would spam prompts.
        return {
          ok: false,
          summary: `Batch stopped at transfer ${i + 1} (signature rejected). ${succeeded} completed before that.`,
          txHash: firstHash,
          chainId: args.chain,
          error: "user_rejected",
          data: { results },
        };
      }
    }
  }
  return {
    ok: succeeded === args.transfers.length,
    summary: `${succeeded}/${args.transfers.length} transfers confirmed on ${chain.name}.`,
    txHash: firstHash,
    chainId: args.chain,
    data: { results, explorerUrl: firstHash ? explorerTx(args.chain, firstHash) : undefined },
  };
}

// ── deploy_contract ──────────────────────────────────────────────────────────

interface CompiledPayload {
  artifact: { contractName: string; abi: unknown[]; bytecode: string };
  constructorArgs: unknown[];
  payableValue?: string;
  chainId: number;
}

export async function execDeployContract(
  w: ExecutorWallet,
  args: { mode: string; chain: number; __compiled?: CompiledPayload; [k: string]: unknown },
  progress: ProgressFn,
): Promise<ToolClientResult> {
  try {
    if (!w.address) return { ok: false, summary: "Wallet not connected — this is TERMINAL: do not retry the transfer, ask the user to connect a wallet first.", error: "no_wallet" };
    const compiled = args.__compiled as CompiledPayload | undefined;
    if (!compiled?.artifact?.bytecode) {
      return { ok: false, summary: "Deployment payload missing (server compile step did not attach artifacts).", error: "no_payload" };
    }
    // P11: the authoritative deployment chain is the compiled payload's own
    // chainId (the ASC tools pin 102031) — args.chain is the fallback. This
    // makes the executor immune to a missing chain argument at dispatch.
    const chainId = typeof compiled.chainId === "number" ? compiled.chainId : args.chain;
    const chain = getChainByChainId(chainId);
    if (!chain) return { ok: false, summary: `Unsupported chain ${chainId}.`, error: "bad_chain" };

    await ensureChain(w, chainId, (name) => progress({ text: `Switching to ${name}…` }));
    progress({ text: `Sign the ${compiled.artifact.contractName} deployment in your wallet…`, chainId }, "awaiting_signature");

    // Owner-specified fix (P13): when the compiled ABI has no constructor — or
    // a constructor with zero parameters — pass args: undefined instead of
    // forwarding the parameters object (viem's encodeDeployData throws
    // AbiConstructorNotFoundError / AbiConstructorParamsNotFoundError for a
    // non-empty args array in exactly those cases). Any stray args for a
    // zero-arg contract are flagged on the confirmation card by the prepare
    // layer, so nothing is silently surprising.
    const deployAbi = (Array.isArray(compiled.artifact.abi) ? compiled.artifact.abi : []) as Array<{
      type?: string;
      inputs?: unknown[];
    }>;
    const ctor = deployAbi.find((x) => x && x.type === "constructor");
    const hasZeroArgConstructor = !ctor || !Array.isArray(ctor.inputs) || ctor.inputs.length === 0;
    const rawArgs = Array.isArray(compiled.constructorArgs) ? compiled.constructorArgs : [];
    const deployArgs = hasZeroArgConstructor ? undefined : (rawArgs as never[]);

    const deployHash = (await w.walletClient!.deployContract({
      abi: compiled.artifact.abi,
      bytecode: compiled.artifact.bytecode as `0x${string}`,
      args: deployArgs,
      value: compiled.payableValue ? BigInt(compiled.payableValue) : undefined,
      chain: VIEM_CHAINS[chainId] ?? null,
      account: w.address!,
      ...(await feeOverridesFor(chainId)),
    })) as Hash;

    progress({ text: "Deployment broadcast — waiting for the receipt…", txHash: deployHash, chainId }, "broadcast");
    const receipt = await waitForTx(chainId, deployHash, (text) =>
      progress({ text, txHash: deployHash, chainId }, "confirming"),
    );
    if (receipt.status === "receipt_timeout") {
      return receiptTimeoutResult(chainId, deployHash, "deployment");
    }
    if (receipt.status !== "success") {
      return { ok: false, summary: `Deployment reverted (tx ${deployHash.slice(0, 14)}…).`, txHash: deployHash, chainId, error: "reverted" };
    }

    // Deployed address = CREATE address of (deployer, nonce used by the deploy tx).
    let finalAddress: Address | null = null;
    try {
      const client = publicClientFor(chainId);
      const tx = await client.getTransaction({ hash: deployHash });
      finalAddress = getContractAddress({ from: tx.from, nonce: BigInt(tx.nonce) });
    } catch {
      finalAddress = null;
    }

    progress({ text: `Deployed at ${finalAddress ?? "address pending"}`, txHash: deployHash, chainId, address: finalAddress ?? undefined }, "succeeded");
    return {
      ok: true,
      summary: `${compiled.artifact.contractName} deployed on ${chain.name} at ${finalAddress ?? "(see explorer)"} (block ${receipt.blockNumber}).`,
      txHash: deployHash,
      chainId,
      address: finalAddress ?? undefined,
      data: { contractAddress: finalAddress, explorerUrl: explorerTx(chainId, deployHash), template: String(args.template ?? args.sourceName ?? compiled.artifact.contractName) },
    };
  } catch (e) {
    const { message, code } = err(e);
    return { ok: false, summary: code === "user_rejected" ? "You rejected the deployment signature." : `Deployment failed: ${message}`, error: code ?? "deploy_failed" };
  }
}

// ── Attestcoin flow executors ────────────────────────────────────────────────

const CONDITIONAL_RELEASE_ABI = [
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "blockHeight", type: "uint64" },
      { name: "encodedTransaction", type: "bytes" },
      { name: "merkleRoot", type: "bytes32" },
      {
        name: "siblings",
        type: "tuple[]",
        components: [
          { name: "hash", type: "bytes32" },
          { name: "isLeft", type: "bool" },
        ],
      },
      { name: "lowerEndpointDigest", type: "bytes32" },
      { name: "continuityRoots", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

export interface RawProofForClient {
  chainKey: number;
  headerNumber: number;
  txBytes: string;
  merkleProof: {
    root: string;
    siblings: Array<{ hash: string; isLeft: boolean }>;
  };
  continuityProof: {
    lowerEndpointDigest: string;
    roots: string[];
  };
}

/**
 * execute_conditional_release: the server fetched the proof (attached by the
 * dispatch layer as __proof); the wallet submits it to the ASC — verification
 * + release happen atomically ON-CHAIN.
 */
export async function execConditionalRelease(
  w: ExecutorWallet,
  args: {
    contractAddress: string;
    sourceTxHash: string;
    mode?: "conditional_release" | "swap_release";
    __proof?: RawProofForClient;
    [k: string]: unknown;
  },
  progress: ProgressFn,
): Promise<ToolClientResult> {
  try {
    if (!w.address) return { ok: false, summary: "Wallet not connected — this is TERMINAL: do not retry the transfer, ask the user to connect a wallet first.", error: "no_wallet" };
    const proof = args.__proof as RawProofForClient | undefined;
    if (!proof) {
      return { ok: false, summary: "Proof payload missing — the server did not attach the attestation proof.", error: "no_proof" };
    }
    const chainId = 102031; // Creditcoin Testnet — the ASC chain
    await ensureChain(w, chainId, (name) => progress({ text: `Switching to ${name}…` }));
    progress(
      { text: "Sign the proof submission — the contract verifies it on-chain and releases…", chainId, merkleRoot: proof.merkleProof.root },
      "awaiting_signature",
    );

    const isSwap = args.mode === "swap_release";
    const hash = (await w.walletClient!.writeContract({
      address: args.contractAddress as Address,
      abi: isSwap ? SWAP_DESTINATION_ABI : CONDITIONAL_RELEASE_ABI,
      functionName: isSwap ? "releaseWithProof" : "release",
      args: [
        BigInt(proof.chainKey),
        BigInt(proof.headerNumber),
        proof.txBytes as `0x${string}`,
        proof.merkleProof.root as `0x${string}`,
        proof.merkleProof.siblings.map((s) => ({ hash: s.hash as `0x${string}`, isLeft: s.isLeft })),
        proof.continuityProof.lowerEndpointDigest as `0x${string}`,
        proof.continuityProof.roots.map((r) => r as `0x${string}`),
      ],
      chain: VIEM_CHAINS[chainId] ?? null,
      account: w.address!,
      ...(await feeOverridesFor(chainId)),
    })) as Hash;

    progress({ text: "Proof submitted — waiting for on-chain verification + release…", txHash: hash, chainId }, "broadcast");
    const receipt = await waitForTx(chainId, hash, (text) =>
      progress({ text, txHash: hash, chainId }, "confirming"),
    );
    if (receipt.status === "receipt_timeout") {
      return receiptTimeoutResult(chainId, hash, "conditional release");
    }
    if (receipt.status !== "success") {
      return {
        ok: false,
        summary: `The release transaction reverted (tx ${hash.slice(0, 14)}…). The condition may not be met, or the escrow already released/expired.`,
        txHash: hash,
        chainId,
        error: "reverted",
      };
    }
    return {
      ok: true,
      summary: `Conditional release executed on-chain: proof verified by the BlockProver precompile and escrow released (Creditcoin block ${receipt.blockNumber}).`,
      txHash: hash,
      chainId,
      data: {
        explorerUrl: explorerTx(chainId, hash),
        merkleRoot: proof.merkleProof.root,
        sourceTxHash: args.sourceTxHash,
        sourceBlock: proof.headerNumber,
        continuityRoots: proof.continuityProof.roots.length,
      },
    };
  } catch (e) {
    const { message, code } = err(e);
    return { ok: false, summary: code === "user_rejected" ? "You rejected the release signature." : `Release failed: ${message}`, error: code ?? "release_failed" };
  }
}

const SWAP_DESTINATION_ABI = [
  {
    type: "function",
    name: "releaseWithProof",
    stateMutability: "nonpayable",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "blockHeight", type: "uint64" },
      { name: "encodedTransaction", type: "bytes" },
      { name: "merkleRoot", type: "bytes32" },
      {
        name: "siblings",
        type: "tuple[]",
        components: [
          { name: "hash", type: "bytes32" },
          { name: "isLeft", type: "bool" },
        ],
      },
      { name: "lowerEndpointDigest", type: "bytes32" },
      { name: "continuityRoots", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

const SWAP_SOURCE_ABI = [
  {
    type: "function",
    name: "lock",
    stateMutability: "payable",
    inputs: [
      { name: "destBeneficiary", type: "address" },
      { name: "rateTctcPerEth", type: "uint256" },
    ],
    outputs: [{ name: "lockId", type: "uint256" }],
  },
] as const;

/** Shared: submit any proof-carrying release call (swap destination). */
export async function execProofReleaseCall(
  w: ExecutorWallet,
  contractAddress: string,
  functionName: "releaseWithProof",
  proof: RawProofForClient,
  chainId: number,
  progress: ProgressFn,
  context: { label: string; extra?: Record<string, unknown> },
): Promise<ToolClientResult> {
  try {
    if (!w.address) return { ok: false, summary: "Wallet not connected — this is TERMINAL: do not retry the transfer, ask the user to connect a wallet first.", error: "no_wallet" };
    await ensureChain(w, chainId, (name) => progress({ text: `Switching to ${name}…` }));
    progress({ text: `Sign the ${context.label} submission…`, chainId, merkleRoot: proof.merkleProof.root }, "awaiting_signature");
    const hash = (await w.walletClient!.writeContract({
      address: contractAddress as Address,
      abi: SWAP_DESTINATION_ABI,
      functionName,
      args: [
        BigInt(proof.chainKey),
        BigInt(proof.headerNumber),
        proof.txBytes as `0x${string}`,
        proof.merkleProof.root as `0x${string}`,
        proof.merkleProof.siblings.map((s) => ({ hash: s.hash as `0x${string}`, isLeft: s.isLeft })),
        proof.continuityProof.lowerEndpointDigest as `0x${string}`,
        proof.continuityProof.roots.map((r) => r as `0x${string}`),
      ],
      chain: VIEM_CHAINS[chainId] ?? null,
      account: w.address!,
      ...(await feeOverridesFor(chainId)),
    })) as Hash;
    progress({ text: "Broadcast — waiting for on-chain verification…", txHash: hash, chainId }, "broadcast");
    const receipt = await waitForTx(chainId, hash, (text) =>
      progress({ text, txHash: hash, chainId }, "confirming"),
    );
    if (receipt.status === "receipt_timeout") {
      return receiptTimeoutResult(chainId, hash, context.label);
    }
    if (receipt.status !== "success") {
      return { ok: false, summary: `Release reverted (tx ${hash.slice(0, 14)}…).`, txHash: hash, chainId, error: "reverted" };
    }
    return {
      ok: true,
      summary: `${context.label} executed on-chain (block ${receipt.blockNumber}).`,
      txHash: hash,
      chainId,
      data: { explorerUrl: explorerTx(chainId, hash), merkleRoot: proof.merkleProof.root, ...(context.extra ?? {}) },
    };
  } catch (e) {
    const { message, code } = err(e);
    return { ok: false, summary: code === "user_rejected" ? "You rejected the signature." : `${context.label} failed: ${message}`, error: code ?? "release_failed" };
  }
}

export { SWAP_SOURCE_ABI, SWAP_DESTINATION_ABI, resolveToken, waitForTx, explorerTx, ensureChain };
export type { Address, Hash };

// ── cross_chain_swap: the multi-transaction lock→fund flow ───────────────────
//
// Ordering matters: the destination ASC's constructor PINS the source lock
// contract's address, so the source deploys first (Sepolia), then the
// destination (Creditcoin, constructor pre-funded with the tCTC side), then
// the ETH lock. Three signatures. The model continues afterwards:
// wait_for_attestation (server) → execute_conditional_release with
// mode "swap_release" (proof submission → on-chain release at the fixed rate).

export async function execCrossChainSwap(
  w: ExecutorWallet,
  args: {
    lockAmount: string;
    rateTctcPerEth: number;
    destinationAddress?: string | null;
    sourceAddress?: string | null;
    __lockWei?: string;
    __fundWei?: string;
    __rate?: string;
    __sourceChainKey?: number;
    __compiledSource?: CompiledPayload;
    __compiledDestination?: CompiledPayload;
    [k: string]: unknown;
  },
  progress: ProgressFn,
): Promise<ToolClientResult> {
  try {
    if (!w.address) return { ok: false, summary: "Wallet not connected — this is TERMINAL: do not retry the transfer, ask the user to connect a wallet first.", error: "no_wallet" };
    const compiledSource = args.__compiledSource as CompiledPayload | undefined;
    const compiledDest = args.__compiledDestination as CompiledPayload | undefined;
    if (!compiledSource || !compiledDest || !args.__lockWei || !args.__fundWei) {
      return { ok: false, summary: "Swap payload missing (server preparation did not attach artifacts).", error: "no_payload" };
    }
    const destBeneficiary = (args.destinationAddress as string) || w.address;
    // P14 amount integrity: the LOCK side (Sepolia ETH) and the RELEASE side
    // (Creditcoin tCTC) are separate, explicitly-named values. The lock is
    // exactly the requested lockAmount; the release side is pre-funded at
    // lockWei × rate, computed in bigint on the server (never float). The two
    // are never interchangeable, and each is only ever sent on its own chain.
    const lockWei = BigInt(args.__lockWei);
    const fundWei = BigInt(args.__fundWei);
    if (lockWei <= 0n) {
      return { ok: false, summary: "The lock amount resolves to zero — nothing to swap. Provide a positive ETH amount.", error: "bad_amount" };
    }
    if (fundWei <= 0n) {
      return { ok: false, summary: "The tCTC release side resolves to zero — the rate or amount is too small to fund the destination contract. Increase the lock amount or the rate.", error: "bad_amount" };
    }
    const rate = args.rateTctcPerEth;
    // The on-chain rate is a uint256 — fractional rates would be silently
    // rounded at the lock, changing the release amount. Fail validation here
    // (bounded correction) instead of moving a different rate than requested.
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isInteger(rate)) {
      return {
        ok: false,
        summary: `rateTctcPerEth must be a positive integer number of tCTC per 1 ETH (got ${String(rate)}). Re-issue the call with an integer rate.`,
        error: "invalid_args",
      };
    }
    // Resolved source chainKey (from the live Attestcoin chain map at prep
    // time) — pins the destination constructor to the SAME chain the lock
    // lives on. Fallback 1 = Sepolia on testnet per the protocol docs.
    const sourceChainKey = typeof args.__sourceChainKey === "number" && args.__sourceChainKey > 0 ? args.__sourceChainKey : 1;

    // ── 1. Deploy the SOURCE lock contract on Sepolia ────────────────────────
    await ensureChain(w, 11155111, (name) => progress({ text: `Switching to ${name}…` }));
    progress({ text: "Step 1/3 — deploy the Sepolia lock contract…", chainId: 11155111 }, "awaiting_signature");
    const sourceHash = (await w.walletClient!.deployContract({
      abi: compiledSource.artifact.abi,
      bytecode: compiledSource.artifact.bytecode as `0x${string}`,
      args: [],
      chain: VIEM_CHAINS[11155111] ?? null,
      account: w.address!,
      ...(await feeOverridesFor(11155111)),
    })) as Hash;
    progress({ text: "Lock contract deployed — waiting for receipt…", txHash: sourceHash, chainId: 11155111 }, "broadcast");
    const sourceReceipt = await waitForTx(11155111, sourceHash, (text) =>
      progress({ text, txHash: sourceHash, chainId: 11155111 }, "confirming"),
    );
    if (sourceReceipt.status === "receipt_timeout") {
      return receiptTimeoutResult(11155111, sourceHash, "swap source deployment");
    }
    if (sourceReceipt.status !== "success") {
      return { ok: false, summary: `Source lock deployment reverted (tx ${sourceHash.slice(0, 14)}…).`, txHash: sourceHash, chainId: 11155111, error: "reverted" };
    }
    let sourceAddress: Address | null = null;
    try {
      const sepoliaClient = publicClientFor(11155111);
      const sourceTx = await sepoliaClient.getTransaction({ hash: sourceHash });
      sourceAddress = getContractAddress({ from: sourceTx.from, nonce: BigInt(sourceTx.nonce) });
    } catch {
      sourceAddress = null;
    }
    if (!sourceAddress) {
      return { ok: false, summary: "Source contract deployed but its address could not be computed — aborting before the funding step.", txHash: sourceHash, chainId: 11155111, error: "no_address" };
    }

    // ── 2. Deploy the DESTINATION release ASC on Creditcoin, pre-funded ─────
    await ensureChain(w, 102031, (name) => progress({ text: `Switching to ${name}…` }));
    progress(
      { text: "Step 2/3 — deploy + pre-fund the Creditcoin release contract…", chainId: 102031, address: sourceAddress },
      "awaiting_signature",
    );
    const destHash = (await w.walletClient!.deployContract({
      abi: compiledDest.artifact.abi,
      bytecode: compiledDest.artifact.bytecode as `0x${string}`,
      args: [BigInt(sourceChainKey), sourceAddress] as never[],
      value: fundWei,
      chain: VIEM_CHAINS[102031] ?? null,
      account: w.address!,
      ...(await feeOverridesFor(102031)),
    })) as Hash;
    progress({ text: "Release contract deployed — waiting for receipt…", txHash: destHash, chainId: 102031 }, "broadcast");
    const destReceipt = await waitForTx(102031, destHash, (text) =>
      progress({ text, txHash: destHash, chainId: 102031 }, "confirming"),
    );
    if (destReceipt.status === "receipt_timeout") {
      return receiptTimeoutResult(102031, destHash, "swap destination deployment");
    }
    if (destReceipt.status !== "success") {
      return {
        ok: false,
        summary: `Destination deployment reverted (tx ${destHash.slice(0, 14)}…). The locked ETH is safe: nothing was locked yet. The source contract is at ${sourceAddress}.`,
        txHash: destHash,
        chainId: 102031,
        error: "reverted",
      };
    }
    let destAddress: Address | null = null;
    try {
      const ccClient = publicClientFor(102031);
      const destTx = await ccClient.getTransaction({ hash: destHash });
      destAddress = getContractAddress({ from: destTx.from, nonce: BigInt(destTx.nonce) });
    } catch {
      destAddress = null;
    }

    // ── 3. Lock the ETH on Sepolia at the fixed rate ─────────────────────────
    await ensureChain(w, 11155111);
    progress({ text: "Step 3/3 — lock the ETH on Sepolia…", chainId: 11155111, address: sourceAddress }, "awaiting_signature");
    const lockHash = (await w.walletClient!.writeContract({
      address: sourceAddress as Address,
      abi: SWAP_SOURCE_ABI,
      functionName: "lock",
      args: [destBeneficiary as Address, BigInt(rate)],
      value: lockWei,
      chain: VIEM_CHAINS[11155111] ?? null,
      account: w.address!,
      ...(await feeOverridesFor(11155111)),
    })) as Hash;
    progress({ text: "Lock broadcast — waiting for receipt…", txHash: lockHash, chainId: 11155111 }, "broadcast");
    const lockReceipt = await waitForTx(11155111, lockHash, (text) =>
      progress({ text, txHash: lockHash, chainId: 11155111 }, "confirming"),
    );
    if (lockReceipt.status === "receipt_timeout") {
      return receiptTimeoutResult(11155111, lockHash, "ETH lock");
    }
    if (lockReceipt.status !== "success") {
      return {
        ok: false,
        summary: `The ETH lock reverted (tx ${lockHash.slice(0, 14)}…) — nothing is locked. The pre-funded release contract is at ${destAddress ?? "?"} on Creditcoin; the funds there are recoverable by its deployer only via a release, or consider this a burn — contact support.`,
        txHash: lockHash,
        chainId: 11155111,
        error: "reverted",
      };
    }

    return {
      ok: true,
      summary: `Swap staged: ${args.lockAmount} ETH locked on Sepolia (tx ${lockHash.slice(0, 14)}…), release side pre-funded on Creditcoin at ${destAddress ?? "?"}, rate fixed at ${rate} tCTC/ETH. Next: wait for Attestcoin attestation of the lock tx, then release with the proof.`,
      txHash: lockHash,
      chainId: 11155111,
      data: {
        sourceContract: sourceAddress,
        destinationContract: destAddress ?? undefined,
        lockTxHash: lockHash,
        explorerUrl: explorerTx(11155111, lockHash),
        destBeneficiary,
        rate,
        lockAmount: args.lockAmount,
      },
    };
  } catch (e) {
    const { message, code } = err(e);
    return { ok: false, summary: code === "user_rejected" ? "You rejected a swap signature — the flow stopped." : `Swap failed: ${message}`, error: code ?? "swap_failed" };
  }
}
