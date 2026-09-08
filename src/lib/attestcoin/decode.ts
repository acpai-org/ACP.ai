import { Contract, JsonRpcProvider } from "ethers";
import { utils } from "@gluwa/usc-sdk";
import decoderAbi from "@gluwa/usc-sdk/dist/utils/evmV1DecoderAbi.json";
import { attestcoinEndpoints, attestcoinEnv, ATTESTCOIN_TIMEOUT_MS } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// EvmV1Decoder integration (C2 / G4).
//
// The app has always configured the decoder contract address but never called
// it. `utils.decoder.decodeEvmV1Transaction` eth_calls the deployed
// EvmV1Decoder on Creditcoin and returns the full decoded tx (from/to/value/
// data + receipt status/gas/logs) straight from the PROOF's txBytes — the
// protocol-native source of truth, no source-chain RPC involved.
//
// This closes a genuine trust hole: the precompile verifies the tx WAS in an
// attested block, but never that the tx SUCCEEDED. The decoder's receipt
// status is the missing verdict (verify-certificate check #5).
// ─────────────────────────────────────────────────────────────────────────────

export interface DecodedTxSummary {
  /** EVM transaction type 0-4. */
  type: number;
  from: string;
  /** null for contract-creation txs (toIsNull). */
  to: string | null;
  /** Native value in ether, decimal string. */
  valueEther: string;
  /** Calldata preview (first 10 hex chars incl. selector), null when empty. */
  dataPreview: string | null;
  nonce: number;
  /** The one thing the precompile does NOT check — decoded from the receipt. */
  receiptStatus: "success" | "reverted" | null;
  receiptGasUsed: number | null;
  decodedAt: number;
}

interface DecoderCache {
  env: string;
  provider: JsonRpcProvider;
  contract: Contract;
}

const globalForDecoder = globalThis as unknown as {
  __acpDecoder?: DecoderCache;
  __acpDecodeCache?: Map<string, DecodedTxSummary>;
};

/** Keyed by the tx bytes themselves — decoding is deterministic. */
const DECODE_TTL_MS = 10 * 60_000;

function decoderContract(): Contract {
  const env = attestcoinEnv();
  const cached = globalForDecoder.__acpDecoder;
  if (cached && cached.env === env) return cached.contract;
  const { rpcUrl, decoderAddress } = attestcoinEndpoints();
  const provider = new JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
    batchStallTime: 200,
  });
  const contract = new Contract(decoderAddress, decoderAbi, provider);
  globalForDecoder.__acpDecoder = { env, provider, contract };
  return contract;
}

/** Pure mapper — exported for unit tests. */
export function toDecodedSummary(decoded: {
  type: number;
  data: {
    commonTx: { nonce: bigint; from: string; toIsNull: boolean; to: string; value: bigint; data: string };
    receipt: { receiptStatus: number; receiptGasUsed: bigint };
  };
}): DecodedTxSummary {
  const common = decoded.data.commonTx;
  const receipt = decoded.data.receipt;
  const data = common.data ?? "";
  return {
    type: decoded.type,
    from: common.from,
    to: common.toIsNull ? null : common.to,
    valueEther: formatEtherSmall(common.value),
    dataPreview:
      data && data !== "0x" && data.length > 2 ? data.slice(0, 10) + (data.length > 10 ? "…" : "") : null,
    nonce: Number(common.nonce),
    receiptStatus: receipt.receiptStatus === 1 ? "success" : receipt.receiptStatus === 0 ? "reverted" : null,
    receiptGasUsed: receipt.receiptGasUsed != null ? Number(receipt.receiptGasUsed) : null,
    decodedAt: Date.now(),
  };
}

/** bigint wei → decimal ether string (small local helper). */
function formatEtherSmall(wei: bigint): string {
  const neg = wei < 0n;
  const abs = (neg ? -wei : wei).toString().padStart(19, "0");
  const whole = abs.slice(0, -18);
  const frac = abs.slice(-18).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac.slice(0, 6) : ""}`;
}

/**
 * Decode a proof's txBytes via the deployed EvmV1Decoder on Creditcoin.
 * Never throws — returns null on any failure so callers degrade gracefully.
 */
export async function decodeTxBytes(txBytes: string, cacheKey?: string): Promise<DecodedTxSummary | null> {
  if (!txBytes || txBytes === "0x" || txBytes.length < 4) return null;
  const key = cacheKey ?? txBytes;
  const cache = (globalForDecoder.__acpDecodeCache ??= new Map());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.decodedAt < DECODE_TTL_MS) return hit;

  const deadline = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), ATTESTCOIN_TIMEOUT_MS).unref?.(),
  );
  try {
    const decoded = await Promise.race([
      utils.decoder.decodeEvmV1Transaction(txBytes, decoderContract()),
      deadline,
    ]);
    if (!decoded) return null;
    const summary = toDecodedSummary(decoded);
    cache.set(key, summary);
    return summary;
  } catch {
    return null;
  }
}
