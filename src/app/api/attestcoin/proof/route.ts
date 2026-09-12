import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { getTxProof, proofCostContext } from "@/lib/attestcoin/proof";
import { verifyProofOnChain } from "@/lib/attestcoin/verify";
import { attestcoinEndpoints, attestcoinEnv } from "@/lib/attestcoin/config";
import { ensureSourceChainMapFresh, sourceChainByEvmId, sourceChainByKey } from "@/lib/attestcoin/chains";
import { getAttestcoinStatus, getAttestationBounds } from "@/lib/attestcoin/status";
import { decodeTxBytes } from "@/lib/attestcoin/decode";
import { VIEM_CHAINS, getChainByChainId } from "@/lib/chains/registry";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/**
 * Transaction inclusion proof for a source-chain tx hash, fetched from the
 * hosted Attestcoin Proof Builder.
 *   GET /api/attestcoin/proof?chainKey=1&txHash=0x…
 *   GET /api/attestcoin/proof?evmChainId=11155111&txHash=0x…
 * (evmChainId accepts the wallet-side chain id — the client doesn't know
 * Creditcoin chain keys; the server resolves the mapping.)
 *
 * When a proof exists it is ALSO verified against the Block Prover
 * Precompile (0x0FD2) via a read-only eth_call — the Creditcoin chain itself
 * re-checks the Merkle + continuity proof. The `onchain` field in the
 * response reports that result. On-chain submission (a signed tx) is a
 * separate user action: POST /api/payments/[id]/attest.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const chainKeyRaw = url.searchParams.get("chainKey");
  const evmChainIdRaw = url.searchParams.get("evmChainId");
  const txHash = url.searchParams.get("txHash");

  if (!txHash || !TX_HASH_RE.test(txHash)) {
    return NextResponse.json({ error: "txHash must be a 32-byte hex string (0x…64)" }, { status: 400 });
  }

  // G1 — live chain-key resolution before the lookup.
  await ensureSourceChainMapFresh();
  const chain = evmChainIdRaw
    ? sourceChainByEvmId(Number(evmChainIdRaw))
    : sourceChainByKey(Number(chainKeyRaw));
  if (!chain) {
    return NextResponse.json(
      {
        error: `chain not tracked by this app (chainKey=${chainKeyRaw} evmChainId=${evmChainIdRaw})`,
        state: "unsupported",
      },
      { status: 404 },
    );
  }

  const { raw, ...outcome } = await getTxProof(chain.chainKey, txHash);
  const onchain = raw && outcome.state === "proof" ? await verifyProofOnChain(raw) : null;

  // ── C2 enrichment (same trio as the payment attestcoin route) ─────────────
  const status = await getAttestcoinStatus().catch(() => null);
  const chainRow = status?.chains.find((c) => c.chainKey === chain.chainKey) ?? null;
  let decoded: Awaited<ReturnType<typeof decodeTxBytes>> = null;
  let cost: ReturnType<typeof proofCostContext> | null = null;
  let bounds: Awaited<ReturnType<typeof getAttestationBounds>> = null;

  if (outcome.state === "proof" && outcome.proof) {
    cost = proofCostContext(outcome.proof, chainRow?.attestedHeight ?? null);
    if (raw?.txBytes) decoded = await decodeTxBytes(raw.txBytes, txHash);
  } else if (outcome.state === "pending" || outcome.state === "unknown_tx") {
    // N2: unknown_tx (builder 404 — tx known but not attested yet) gets the
    // same attestation-bounds enrichment as pending, so the UI can still show
    // how far behind the attested head the tx's block is.
    try {
      const viemChain = VIEM_CHAINS[chain.evmChainId];
      const registryChain = getChainByChainId(chain.evmChainId);
      if (viemChain) {
        const client = createPublicClient({
          chain: viemChain,
          transport: http(registryChain?.rpcUrls?.[0], { timeout: 6_000, retryCount: 0 }),
        });
        const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
        if (tx?.blockNumber != null) {
          bounds = await getAttestationBounds(chain.chainKey, Number(tx.blockNumber));
        }
      }
    } catch {
      bounds = null;
    }
  }

  const httpStatus = outcome.state === "error" ? 502 : 200;
  return NextResponse.json(
    {
      ...outcome,
      ...(onchain ? { onchain } : {}),
      ...(decoded ? { decoded } : {}),
      ...(cost ? { cost } : {}),
      ...(bounds ? { bounds } : {}),
      chain: { chainKey: chain.chainKey, evmChainId: chain.evmChainId, name: chain.name },
      env: attestcoinEnv(),
      dashboard: attestcoinEndpoints().dashboardUrl,
    },
    { status: httpStatus },
  );
}
