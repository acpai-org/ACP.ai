import { getTxProof } from "@/lib/attestcoin/proof";
import { ensureSourceChainMapFresh, sourceChainByEvmId } from "@/lib/attestcoin/chains";
import { compileContract } from "@/lib/contracts/compile";
import type { ContractConfirmationInfo } from "@/lib/agent/events";
import type { RawProofForClient } from "@/lib/agent/client-executors";
import { FUND_TRANSFER_GAS, type FeeBreakdownEntry } from "@/lib/agent/fee-estimate";
import { VIEM_CHAINS, getChainByChainId } from "@/lib/chains/registry";
import { createPublicClient, http, erc20Abi, encodeFunctionData, parseUnits, type Address } from "viem";
import { estimateGasLive } from "@/lib/agent/gas-live";
import { CONDITIONAL_RELEASE_ABI, SWAP_DESTINATION_ABI } from "@/lib/agent/asc-abi";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side PREPARATION for client-executed tools, run inside the loop
// before dispatch: compile what needs compiling, fetch proofs that the wallet
// will submit, and build the confirmation payloads. The browser never compiles
// and never fetches proofs itself — it receives ready artifacts.
// ─────────────────────────────────────────────────────────────────────────────

export interface PreparedClientTool {
  ok: boolean;
  error?: string;
  /** Extra info merged into the confirmation card (contract path). */
  contractInfo?: ContractConfirmationInfo;
  /** Enriched args dispatched to the client (proof payloads, compiled artifacts). */
  enrichedArgs?: Record<string, unknown>;
  /** Per-tx gas breakdown for multi-tx tools (fee row on the card). */
  feeBreakdown?: FeeBreakdownEntry[];
}

function toWeiStr(amountHuman: unknown): string {
  const s = String(amountHuman ?? "0");
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  try {
    return (BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0")).toString();
  } catch {
    return "0";
  }
}

/** Compact human rendering of a wei value for plain-English summaries. */
function formatWeiForSummary(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export async function prepareClientTool(
  tool: string,
  args: Record<string, unknown>,
  walletAddress?: string | null,
): Promise<PreparedClientTool> {
  switch (tool) {
    // deploy_contract is prepared by lib/contracts/prepare (called from the
    // loop's confirmation branch) — nothing to do here.
    case "deploy_contract":
      return { ok: true };

    // ── transfer / batch_transfer: LIVE gas estimation (P5) ───────────────
    // eth_estimateGas against the exact tx shape (to/value or ERC-20
    // calldata). Estimation failure → the leg is omitted ("real or absent"),
    // with one exception: plain native transfers have a PROTOCOL-EXACT cost
    // (21000, EIP-158) which is a fact, not an estimate.
    case "transfer":
    case "batch_transfer": {
      const chainId = typeof args.chain === "number" ? args.chain : null;
      const chain = chainId != null ? getChainByChainId(chainId) : null;
      if (chainId == null || !chain) return { ok: true };
      const list =
        tool === "transfer"
          ? [args as Record<string, unknown>]
          : Array.isArray(args.transfers)
            ? (args.transfers as Array<Record<string, unknown>>)
            : [];
      const entries: FeeBreakdownEntry[] = [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const sym = String(t.token ?? "").toUpperCase();
        const isNative = sym === chain.nativeCurrency.symbol.toUpperCase();
        const known = chain.tokens.find((tk) => tk.symbol.toUpperCase() === sym);
        const label =
          tool === "transfer"
            ? `Transfer ${String(t.amount ?? "?")} ${String(t.token ?? "?")}`
            : `Transfer ${i + 1} · ${String(t.amount ?? "?")} ${String(t.token ?? "?")}`;
        let gasUnits: string | null = null;
        try {
          if (isNative) {
            const value = parseUnits(String(t.amount ?? "0"), chain.nativeCurrency.decimals);
            gasUnits =
              (await estimateGasLive(chainId, {
                account: walletAddress ?? null,
                to: String(t.recipient ?? ""),
                value,
              }))?.toString() ?? null;
            if (gasUnits == null) gasUnits = "21000"; // protocol-exact (EIP-158)
          } else if (known) {
            const data = encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [String(t.recipient ?? "") as Address, parseUnits(String(t.amount ?? "0"), known.decimals)],
            });
            gasUnits =
              (await estimateGasLive(chainId, {
                account: walletAddress ?? null,
                to: known.address,
                data,
              }))?.toString() ?? null;
          }
          // Unknown token symbols/addresses: the client probes decimals at
          // execution; the exact calldata is unknowable at prep → no estimate.
        } catch {
          gasUnits = null;
        }
        if (gasUnits != null) entries.push({ label, gasUnits, chainId });
      }
      return entries.length > 0 ? { ok: true, feeBreakdown: entries } : { ok: true };
    }

    // ── create_conditional_release: compile the ASC + escrow value ──────────
    case "create_conditional_release": {
      try {
        const artifact = await compileContract("ConditionalRelease.sol");
        const srcChain = typeof args.sourceChain === "number" ? (args.sourceChain as number) : 11155111;
        // G1 — resolve the chain key from the live ChainInfo map. Fail CLOSED:
        // an unresolvable source chain pins a wrong key into the contract
        // constructor (it would silently verify the wrong chain's proofs).
        await ensureSourceChainMapFresh();
        const src = sourceChainByEvmId(srcChain);
        if (!src) {
          return {
            ok: false,
            error: `Source chain ${srcChain} is not an Attestcoin source chain in this environment — the release condition cannot be pinned to it. Supported sources are returned by list_chains / attestcoin_network_status.`,
          };
        }
        const chainKey = src.chainKey;
        // Condition constraints: the agent may pass payer/payee/minValue or
        // erc20 constraints explicitly; sourceTxHash alone (no other
        // constraints) pins the condition to THAT transaction's own sender
        // (and value when known) — fetched live from the source RPC so the
        // deployed contract gates on the actual payer, not on a vacuous
        // minValue that almost any successful tx would satisfy.
        const hasExplicit =
          (args.payer as string) || (args.payee as string) || (args.minValue as string) || (args.erc20Token as string);
        let payer = hasExplicit ? String(args.payer ?? ZERO_ADDR) : ZERO_ADDR;
        let payee = hasExplicit ? String(args.payee ?? ZERO_ADDR) : ZERO_ADDR;
        let minValueWei = hasExplicit ? toWeiStr(args.minValue ?? "0") : "0";
        if (!hasExplicit && typeof args.sourceTxHash === "string" && /^0x[a-fA-F0-9]{64}$/.test(args.sourceTxHash)) {
          try {
            const chainDef = getChainByChainId(srcChain);
            const client = createPublicClient({
              chain: VIEM_CHAINS[srcChain],
              transport: http(chainDef?.rpcUrls[0] ?? "", { timeout: 10_000 }),
            });
            const tx = await client.getTransaction({ hash: args.sourceTxHash as `0x${string}` }).catch(() => null);
            if (tx) {
              payer = tx.from;
              if (tx.to) payee = tx.to;
              if (tx.value > 0n) minValueWei = tx.value.toString();
            }
            // If the tx is unknown on-chain yet, fall through to the generic
            // guard below (minValue 1 wei) — the model is told the tx gates it.
          } catch {
            /* tx fetch failed — fall through to the zero-guard */
          }
        }
        const constructorArgs = [
          args.beneficiary,
          chainKey,
          payer,
          payee,
          minValueWei,
          (args.erc20Token as string) ?? ZERO_ADDR,
          (args.erc20From as string) ?? ZERO_ADDR,
          (args.erc20To as string) ?? ZERO_ADDR,
          toWeiStr(args.erc20MinAmount ?? "0"),
          (args.timeoutHours as number) ?? 72,
        ];
        // Zero-constraint guard: require at least the payee or minValue.
        if (
          constructorArgs[2] === ZERO_ADDR &&
          constructorArgs[3] === ZERO_ADDR &&
          constructorArgs[4] === "0" &&
          constructorArgs[5] === ZERO_ADDR
        ) {
          constructorArgs[4] = "1"; // minValue 1 wei — any successful tx qualifies
        }
        return {
          ok: true,
          contractInfo: {
            template: "conditional_release",
            source: "contracts/ConditionalRelease.sol (vetted Attestcoin ASC template)",
            plainSummary: `Escrows ${String(args.amount)} tCTC on Creditcoin Testnet in a ConditionalRelease ASC. Funds release to the beneficiary only when a Merkle+continuity proof of the condition transaction on ${src?.name ?? "Sepolia"} is verified on-chain by the Block Prover precompile — verification and release are atomic. Refundable after ${String((args.timeoutHours as number) ?? 72)}h.`,
            estimatedGas: artifact.creationGas ?? undefined,
          },
          enrichedArgs: {
            __compiled: {
              artifact: { contractName: artifact.contractName, abi: artifact.abi, bytecode: artifact.bytecode },
              constructorArgs,
              payableValue: toWeiStr(args.amount),
              chainId: 102031,
            },
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // ── execute_conditional_release / swap release: fetch the proof ─────────
    case "execute_conditional_release": {
      const txHash = String(args.sourceTxHash ?? "");
      if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        return { ok: false, error: "sourceTxHash must be a valid tx hash." };
      }
      const srcChain = typeof args.chain === "number" ? (args.chain as number) : 11155111;
      // G1 — resolve the chain key from the live ChainInfo map.
      await ensureSourceChainMapFresh();
      const src = sourceChainByEvmId(srcChain) ?? sourceChainByEvmId(11155111)!;
      const outcome = await getTxProof(src.chainKey, txHash);
      if (outcome.state !== "proof" || !outcome.raw) {
        return {
          ok: false,
          error:
            outcome.state === "pending"
              ? `Not attested yet — call wait_for_attestation first (proof builder says: ${outcome.detail ?? "pending"}).`
              : `Proof lookup failed: ${outcome.detail ?? outcome.state}`,
        };
      }
      const raw = outcome.raw as unknown as RawProofForClient;
      const merkleProof = raw.merkleProof as unknown as {
        root: string;
        siblings: Array<{ digest?: string; hash?: string; isLeft?: boolean }>;
      };
      const siblings = (merkleProof.siblings ?? []).map((s) => ({
        hash: String(s.hash ?? s.digest ?? ""),
        isLeft: Boolean(s.isLeft),
      }));
      const proofForClient: RawProofForClient = {
        chainKey: raw.chainKey,
        headerNumber: raw.headerNumber,
        txBytes: raw.txBytes,
        merkleProof: { root: String(merkleProof.root), siblings },
        continuityProof: {
          lowerEndpointDigest: String((raw.continuityProof as unknown as { lowerEndpointDigest: string }).lowerEndpointDigest),
          roots: ((raw.continuityProof as unknown as { roots: string[] }).roots ?? []).map(String),
        },
      };
      // P5: LIVE gas estimation for the release — the exact proof calldata
      // is fully known here, so eth_estimateGas returns the REAL cost of the
      // on-chain verification + release (verification gas scales with the
      // proof's sibling/continuity lengths — no flat constant can be honest).
      // Estimation failure → no fee row ("real or absent").
      let feeBreakdown: FeeBreakdownEntry[] | undefined;
      try {
        const isSwap = args.mode === "swap_release";
        // viem's literal-ABI typing is narrower than this dynamic call site —
        // cast through unknown (the runtime shapes are verified by tests).
        const encode = encodeFunctionData as unknown as (p: {
          abi: unknown;
          functionName: string;
          args: unknown[];
        }) => `0x${string}`;
        const data = encode({
          abi: isSwap ? SWAP_DESTINATION_ABI : CONDITIONAL_RELEASE_ABI,
          functionName: isSwap ? "releaseWithProof" : "release",
          args: [
            BigInt(proofForClient.chainKey),
            BigInt(proofForClient.headerNumber),
            proofForClient.txBytes,
            proofForClient.merkleProof.root,
            proofForClient.merkleProof.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })),
            proofForClient.continuityProof.lowerEndpointDigest,
            proofForClient.continuityProof.roots,
          ],
        });
        const gas = await estimateGasLive(102031, {
          account: walletAddress ?? null,
          to: String(args.contractAddress ?? ""),
          data,
        });
        if (gas != null) {
          feeBreakdown = [
            {
              label: isSwap ? "Swap release (verify proof + release tCTC)" : "Conditional release (verify proof + release)",
              gasUnits: gas.toString(),
              chainId: 102031,
            },
          ];
        }
      } catch {
        feeBreakdown = undefined;
      }
      return {
        ok: true,
        enrichedArgs: { __proof: proofForClient },
        ...(feeBreakdown ? { feeBreakdown } : {}),
      };
    }

    // ── cross_chain_swap: compile both sides + compute funding ───────────────
    case "cross_chain_swap": {
      try {
        const sourceArtifact = await compileContract("CrossChainSwapSource.sol");
        const destArtifact = await compileContract("CrossChainSwapDestination.sol");
        const lockAmount = String(args.lockAmount ?? "0");
        const rate = Number(args.rateTctcPerEth ?? 0);
        // P14 amount integrity — SINGLE-SOURCED, bigint-only conversion:
        // the lock side is exactly the requested lockAmount in wei; the
        // destination pre-fund is lockWei × rate computed in bigint (float
        // multiplication with toFixed truncation could under-fund the
        // destination and strand both sides). The lock value NEVER derives
        // from the release amount and vice versa.
        const lockWei = BigInt(toWeiStr(lockAmount));
        if (lockWei <= 0n || !Number.isInteger(rate) || rate <= 0) {
          return {
            ok: false,
            error: "Invalid swap parameters: lockAmount must be a positive decimal amount and rateTctcPerEth a positive integer rate (tCTC per 1 ETH).",
          };
        }
        const fundWei = lockWei * BigInt(rate);
        // The source chain's live chainKey (pins the destination constructor).
        await ensureSourceChainMapFresh();
        const srcMap = sourceChainByEvmId(11155111);
        const sourceChainKey = srcMap?.chainKey ?? 1;
        // Per-tx fee breakdown (P5 — every leg is a REAL number):
        //   • destination deploy: solc's creation estimate (compiler-derived),
        //     falling back to live estimateGas on the deployment bytecode;
        //   • pre-funding transfer: protocol-exact 21000 (EIP-158 value send);
        //   • source deploy + ETH lock: solc creation + solc's method estimate
        //     for lock(address,uint256);
        //   • the LATER release leg is NOT estimable before the proof exists —
        //     it is estimated with the real proof calldata at that step's own
        //     preparation (execute_conditional_release), never invented here.
        const destDeployGas =
          destArtifact.creationGas ??
          (await estimateGasLive(102031, { account: walletAddress ?? null, data: destArtifact.bytecode as `0x${string}` }))?.toString() ??
          null;
        const lockMethodGas = sourceArtifact.methodGas["lock(address,uint256)"] ?? null;
        const feeBreakdown: FeeBreakdownEntry[] = [];
        if (destDeployGas != null) {
          feeBreakdown.push({ label: "Deploy release contract on Creditcoin TN", gasUnits: destDeployGas, chainId: 102031 });
        }
        feeBreakdown.push({ label: "Fund it with tCTC", gasUnits: FUND_TRANSFER_GAS.toString(), chainId: 102031 });
        if (sourceArtifact.creationGas != null) {
          feeBreakdown.push({ label: "Deploy lock contract on Sepolia", gasUnits: sourceArtifact.creationGas, chainId: 11155111 });
        }
        if (lockMethodGas != null) {
          feeBreakdown.push({ label: "Lock ETH (lock + 24h refund window)", gasUnits: lockMethodGas, chainId: 11155111 });
        }
        return {
          ok: true,
          contractInfo: {
            template: "crosschain_swap_pair",
            source: "contracts/CrossChainSwapSource.sol + CrossChainSwapDestination.sol (vetted Attestcoin ASC pair)",
            plainSummary: `Attestcoin-secured swap: locks ${lockAmount} ETH on Sepolia at a fixed rate of ${rate} tCTC/ETH, and pre-funds + releases ${formatWeiForSummary(fundWei)} tCTC on Creditcoin Testnet once the lock is proven on-chain. Three signatures now (deploy release side, fund it, lock ETH), one later (release after attestation). Locks are refundable after 24h.`,
          },
          feeBreakdown,
          enrichedArgs: {
            __lockWei: lockWei.toString(),
            __fundWei: fundWei.toString(),
            __rate: rate.toString(),
            __sourceChainKey: sourceChainKey,
            __compiledSource: {
              artifact: { contractName: sourceArtifact.contractName, abi: sourceArtifact.abi, bytecode: sourceArtifact.bytecode },
              constructorArgs: [],
              chainId: 11155111,
            },
            __compiledDestination: {
              artifact: { contractName: destArtifact.contractName, abi: destArtifact.abi, bytecode: destArtifact.bytecode },
              constructorArgs: [sourceChainKey, ZERO_ADDR], // chainKey patched after source deploy — see executor
              chainId: 102031,
            },
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case "transfer":
    case "batch_transfer":
      return { ok: true };

    default:
      return { ok: true };
  }
}
