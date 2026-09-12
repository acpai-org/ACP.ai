import { getChainByChainId } from "@/lib/chains/registry";
import { getDeployPolicy } from "@/lib/agent/policy";
import { compileContract, compileCustomSource, type CompileArtifact } from "@/lib/contracts/compile";

// ─────────────────────────────────────────────────────────────────────────────
// Deployment preparation (server-side half of the deploy_contract tool).
//
// Validates the deployment target against the policy (chain allowlist, ASC
// template chain restriction, mainnet opt-in), compiles the source, and
// produces the confirmation payload: the source (custom path) or template
// identity + parameters (template path) and a plain-English summary.
//
// The confirmation itself is ALWAYS required downstream — nothing here
// bypasses it (hard rule, brief §5/§12).
// ─────────────────────────────────────────────────────────────────────────────

export interface PreparedDeployment {
  ok: boolean;
  error?: string;
  contractInfo?: {
    template?: string;
    source: string;
    plainSummary: string;
    warnings?: string[] | null;
    /** solc creation gas estimate (fee row on the confirmation card). */
    estimatedGas?: string;
  };
  compiled?: {
    artifact: CompileArtifact;
    /** Positional constructor args (client encodes via the artifact ABI). */
    constructorArgs: unknown[];
    /** Payable constructor value (wei string) — the escrow/funding amount. */
    payableValue?: string;
    chainId: number;
  };
}

interface DeployArgs {
  mode: "template" | "custom";
  template: string | null;
  chain: number;
  constructorArgs: Record<string, unknown> | null;
  source: string | null;
  sourceName: string | null;
}

const TEMPLATES: Record<
  string,
  {
    file: string;
    /** Constructor arg names IN ORDER. */
    argOrder: string[];
    /** ASC templates only function where the BlockProver precompile exists. */
    ascOnly: boolean;
    payableValueArg?: string;
    /** Convert a named arg (string human amount) to wei when needed. */
    weiArgs?: string[];
    summary: (args: Record<string, unknown>) => string;
  }
> = {
  erc20: {
    file: "templates/SimpleERC20.sol",
    argOrder: ["name", "symbol", "decimals", "initialSupply", "initialHolder"],
    ascOnly: false,
    summary: (a) =>
      `Mints the total supply of a standard ERC-20 token "${String(a.symbol)}" (${String(a.decimals ?? 18)} decimals) to the initial holder. No minting after deployment, no admin functions.`,
  },
  escrow: {
    file: "templates/SimpleEscrow.sol",
    argOrder: ["beneficiary", "arbiter", "deadlineHours"],
    ascOnly: false,
    payableValueArg: "amount",
    summary: (a) =>
      `Escrows the sent native amount until an arbiter releases it to the beneficiary, or the ${String(a.deadlineHours)}h deadline passes and anyone can refund the depositor.`,
  },
  multisig: {
    file: "templates/SimpleMultisig.sol",
    argOrder: ["owners", "threshold"],
    ascOnly: false,
    summary: (a) =>
      `A ${String(a.threshold)}-of-${Array.isArray(a.owners) ? (a.owners as unknown[]).length : "?"} multisig: owners submit native-value transfers; execution needs ${String(a.threshold)} confirmations.`,
  },
  conditional_release: {
    file: "ConditionalRelease.sol",
    argOrder: [
      "beneficiary",
      "sourceChainKey",
      "payer",
      "payee",
      "minValue",
      "erc20Token",
      "erc20From",
      "erc20To",
      "erc20MinAmount",
      "releaseWindowHours",
    ],
    ascOnly: true,
    payableValueArg: "amount",
    // Human decimal strings → wei (18-decimals native convention). Without
    // this, "0.5" crashes ABI encoding and "5" means 5 wei (audit finding).
    weiArgs: ["minValue", "erc20MinAmount"],
    summary: (a) =>
      `An Attestcoin Smart Contract: escrows ${String(a.amount ?? "")} tCTC now; releases to the beneficiary ONLY when someone proves — on-chain, via the Creditcoin Block Prover precompile — that a successful condition transaction happened on the source chain${a.sourceTxHash ? "" : ""}. Refundable to the depositor after ${String(a.releaseWindowHours ?? 72)}h if unreleased.`,
  },
  crosschain_swap_source: {
    file: "CrossChainSwapSource.sol",
    argOrder: [],
    ascOnly: false,
    summary: () =>
      "The Sepolia side of the Attestcoin-secured swap: users lock ETH with a fixed tCTC rate; the Locked event it emits is what the Creditcoin release contract verifies. Locks are refundable after 24h.",
  },
  crosschain_swap_destination: {
    file: "CrossChainSwapDestination.sol",
    argOrder: ["sourceChainKey", "trustedSourceContract"],
    ascOnly: true,
    summary: (a) =>
      `The Creditcoin side of the Attestcoin-secured swap: holds pre-funded tCTC and releases it at the lock-time rate when a valid proof of a Locked event from the trusted source contract (${String(a.trustedSourceContract ?? "?")}) is verified on-chain by the Block Prover precompile.`,
  },
};

function toWei(amountHuman: unknown): string {
  const s = String(amountHuman ?? "0");
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  try {
    return (BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0")).toString();
  } catch {
    return "0";
  }
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export async function prepareDeployment(
  rawArgs: Record<string, unknown>,
  walletAddress?: string | null,
): Promise<PreparedDeployment> {
  const args = rawArgs as unknown as DeployArgs;
  const chain = getChainByChainId(args.chain);
  if (!chain) return { ok: false, error: `Chain ${args.chain} is not in the supported chain set.` };
  const policy = getDeployPolicy();

  // ── Policy gates ───────────────────────────────────────────────────────────
  if (chain.testnet === false) {
    if (!policy.mainnetDeployOptIn) {
      return {
        ok: false,
        error: `Mainnet deployment is disabled by default. The user must enable it in Settings (Autonomy & safety → mainnet deployment opt-in) first.`,
      };
    }
  }

  if (args.mode === "template") {
    const template = args.template ? TEMPLATES[args.template] : undefined;
    if (!template) return { ok: false, error: `Unknown template "${String(args.template)}". Available: ${Object.keys(TEMPLATES).join(", ")}.` };
    if (template.ascOnly && !chain.key.startsWith("creditcoin")) {
      return {
        ok: false,
        error: `The ${String(args.template)} template is an Attestcoin Smart Contract — the Block Prover precompile (0x…FD2) only exists on Creditcoin chains. Deploy it on Creditcoin Testnet (102031).`,
      };
    }

    // Build positional constructor args from the named-arg object.
    const named = (args.constructorArgs ?? {}) as Record<string, unknown>;
    const positional: unknown[] = [];
    for (const name of template.argOrder) {
      let v = named[name];
      if (v === undefined || v === null) {
        // Sensible defaults per template arg.
        if (name === "sourceChainKey") v = 1; // Sepolia
        else if (name === "payer" || name === "payee" || name === "erc20Token" || name === "erc20From" || name === "erc20To" || name === "arbiter") v = ZERO_ADDR;
        else if (name === "minValue" || name === "erc20MinAmount") v = "0";
        else if (name === "releaseWindowHours" || name === "deadlineHours") v = 72;
        else if (name === "decimals") v = 18;
        else if (name === "owners") v = walletAddress ? [walletAddress] : [];
        else if (name === "threshold") v = 1;
        else if (name === "initialHolder") {
          // Supply must have an owner — minting to 0x0 would burn it. Default
          // to the connected wallet; without a wallet it's a clean prep error.
          if (!walletAddress) {
            return { ok: false, error: "initialHolder is required: connect a wallet so the token supply has an owner (minting to 0x0 would burn it)." };
          }
          v = walletAddress;
        }
        else {
          return { ok: false, error: `Missing constructor argument "${name}" for the ${String(args.template)} template.` };
        }
      }
      // Amount-like args arrive as human strings → wei for 18-decimals native.
      if (template.weiArgs?.includes(name)) v = toWei(v);
      positional.push(v);
    }

    let artifact: CompileArtifact;
    try {
      artifact = await compileContract(template.file);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const payableValue = template.payableValueArg ? toWei(named[template.payableValueArg] ?? rawArgs["amount"]) : undefined;

    return {
      ok: true,
      contractInfo: {
        template: args.template ?? undefined,
        source: `contracts/${template.file} (vetted template, source in the ACP.ai repository)`,
        plainSummary: template.summary(named),
        warnings: artifact.warnings.length > 0 ? artifact.warnings.slice(0, 5) : null,
        estimatedGas: artifact.creationGas ?? undefined,
      },
      compiled: { artifact, constructorArgs: positional, payableValue, chainId: args.chain },
    };
  }

  // ── Custom source path (brief §6b) ─────────────────────────────────────────
  if (args.mode === "custom") {
    const source = args.source ?? "";
    if (!source.trim()) return { ok: false, error: "Custom deployment requires Solidity source." };
    // R19 fix: cap the source size BEFORE solc runs — solc compile is
    // synchronous (blocks the whole Node event loop: every concurrent
    // request/stream stalls for the compile duration) and an unbounded
    // adversarial source could freeze the server for minutes. 128 KB is far
    // beyond any sane single-contract source.
    const MAX_CUSTOM_SOURCE_BYTES = 128 * 1024;
    if (Buffer.byteLength(source, "utf8") > MAX_CUSTOM_SOURCE_BYTES) {
      return { ok: false, error: `Custom source exceeds the ${MAX_CUSTOM_SOURCE_BYTES / 1024} KB limit. Split the contract or remove embedded data.` };
    }
    if (!/pragma solidity/i.test(source)) return { ok: false, error: "Source is missing a pragma directive." };
    if (/^\s*pragma solidity\s+[^;]*0\.[0-6]/m.test(source)) {
      return { ok: false, error: "Solidity versions below 0.8 are not accepted (safety)." };
    }
    if (!/^pragma solidity[^\n]*\^0\.8/m.test(source) && !/pragma solidity[^\n]*>=0\.8/m.test(source)) {
      return { ok: false, error: "Use 'pragma solidity ^0.8.23' (or >=0.8)." };
    }
    const name = (args.sourceName ?? "Custom").replace(/[^A-Za-z0-9_]/g, "") || "Custom";
    let artifact: CompileArtifact;
    try {
      artifact = await compileCustomSource(source, name);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // P13: if the compiled ABI has no constructor (or a zero-parameter one),
    // constructor args are meaningless — flag them on the confirmation card
    // and drop them instead of letting viem's encodeDeployData crash later.
    const customArgs = (args.constructorArgs ? Object.values(args.constructorArgs) : []) as unknown[];
    const customAbi = (Array.isArray(artifact.abi) ? artifact.abi : []) as Array<{ type?: string; inputs?: unknown[] }>;
    const customCtor = customAbi.find((x) => x && x.type === "constructor");
    const customZeroArg = !customCtor || !Array.isArray(customCtor.inputs) || customCtor.inputs.length === 0;
    const zeroArgWarning =
      customZeroArg && customArgs.length > 0
        ? `The contract's constructor takes no parameters, but ${customArgs.length} constructor argument(s) were supplied — they are ignored. Verify this is the intended contract.`
        : null;
    const warnings = [...(artifact.warnings.length > 0 ? artifact.warnings.slice(0, 6) : []), ...(zeroArgWarning ? [zeroArgWarning] : [])];
    return {
      ok: true,
      contractInfo: {
        source,
        plainSummary: `Custom contract "${name}" compiled successfully from agent-generated Solidity. The user must read the source below before approving.`,
        warnings: warnings.length > 0 ? warnings : undefined,
        estimatedGas: artifact.creationGas ?? undefined,
      },
      compiled: {
        artifact,
        constructorArgs: customZeroArg ? [] : customArgs,
        chainId: args.chain,
      },
    };
  }

  return { ok: false, error: "mode must be 'template' or 'custom'." };
}

export function templateSummaries(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, t] of Object.entries(TEMPLATES)) {
    out[key] = t.summary({});
  }
  return out;
}
