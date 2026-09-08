import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Solidity compilation service (server-side only).
//
// Compiles the in-repo contracts (contracts/) + template library with solc-js
// in ONE invocation so the vendored EvmV1Decoder (internal visibility) INLINES
// into every ASC — no library deployment, no linking (decision logged in the
// worklog). @openzeppelin imports resolve from node_modules.
//
// Artifacts are cached by the source-set hash (compiles are deterministic).
// ─────────────────────────────────────────────────────────────────────────────

const G = globalThis as unknown as {
  __acpSolc?: unknown;
  __acpArtifactCache?: Map<string, CompileArtifact>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadSolc(): Promise<any> {
  if (G.__acpSolc) return G.__acpSolc as any;
  // Dynamic import: works in the Next.js server bundle AND under plain
  // node/tsx (tests). solc is CJS — take .default when present.
  const mod = await import("solc");
  const resolved = (mod as any).default && typeof (mod as any).default.compile === "function"
    ? (mod as any).default
    : (mod as any);
  G.__acpSolc = resolved;
  return resolved;
}

function artifactCache(): Map<string, CompileArtifact> {
  if (!G.__acpArtifactCache) G.__acpArtifactCache = new Map();
  return G.__acpArtifactCache;
}

const CONTRACTS_ROOT = path.join(process.cwd(), "contracts");

export interface CompileArtifact {
  contractName: string;
  abi: unknown[];
  /** Creation bytecode WITH 0x prefix (constructor args appended client-side). */
  bytecode: string;
  deployedBytecode: string;
  warnings: string[];
  sourceHash: string;
  /** solc's creation gas estimate (decimal string), when it reports one. */
  creationGas: string | null;
  /**
   * solc's per-method gas estimates (P5 — REAL compiler-derived numbers),
   * keyed by canonical signature, e.g. "lock(address,uint256)". "infinite"
   * (unbounded loops, e.g. proof-verification) is stored as null — callers
   * must treat null as "not estimable", never invent a number.
   */
  methodGas: Record<string, string | null>;
}

interface SolcContractOutput {
  abi?: unknown[];
  evm?: {
    bytecode?: { object?: string };
    deployedBytecode?: { object?: string };
    gasEstimates?: {
      // Modern solc: { codeDepositCost, executionCost, totalCost } (strings).
      // Older versions emitted { "": "395673" } — handle both shapes.
      creation?: Record<string, string | undefined> | string;
      external?: Record<string, string | undefined>;
      internal?: Record<string, string | undefined>;
    };
  };
}

interface SolcOutput {
  errors?: Array<{ severity?: string; formattedMessage?: string; message?: string }>;
  contracts?: Record<string, Record<string, SolcContractOutput>>;
}

/** Read a file from the contracts/ tree (safely, no traversal outside root). */
function readContractFile(relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.includes("..")) return null;
  const base = normalized.startsWith("contracts/") ? normalized : `contracts/${normalized}`;
  const abs = path.join(process.cwd(), base);
  if (!abs.startsWith(CONTRACTS_ROOT)) return null;
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** Read an import from node_modules (@openzeppelin/contracts, etc.). */
function readNodeModulesImport(spec: string): string | null {
  const abs = path.join(process.cwd(), "node_modules", spec);
  if (!abs.includes(path.join(process.cwd(), "node_modules"))) return null;
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** The known source set for a contract (its file + everything it imports). */
const SOURCE_FILES: Record<string, string[]> = {
  "ConditionalRelease.sol": ["ConditionalRelease.sol", "vendor/INativeQueryVerifier.sol", "vendor/EvmV1Decoder.sol"],
  "CrossChainSwapSource.sol": ["CrossChainSwapSource.sol"],
  "CrossChainSwapDestination.sol": [
    "CrossChainSwapDestination.sol",
    "vendor/INativeQueryVerifier.sol",
    "vendor/EvmV1Decoder.sol",
  ],
  "templates/SimpleERC20.sol": ["templates/SimpleERC20.sol"],
  "templates/SimpleEscrow.sol": ["templates/SimpleEscrow.sol"],
  "templates/SimpleMultisig.sol": ["templates/SimpleMultisig.sol"],
};

export function knownContractKeys(): string[] {
  return Object.keys(SOURCE_FILES);
}

function sourceSetHash(files: Array<{ path: string; content: string }>): string {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.path);
    h.update("\0");
    h.update(f.content);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 24);
}

/**
 * Compile one in-repo contract. `key` is the file name relative to contracts/.
 * Custom (agent-generated) sources compile through compileCustomSource().
 */
export async function compileContract(key: string): Promise<CompileArtifact> {
  const files = SOURCE_FILES[key];
  if (!files) throw new Error(`Unknown contract: ${key}`);

  const sources: Record<string, { content: string }> = {};
  for (const rel of files) {
    const content = readContractFile(rel);
    if (content == null) throw new Error(`Missing contract source: contracts/${rel}`);
    sources[`contracts/${rel}`] = { content };
  }
  return runSolc(sources, contractNameFromKey(key));
}

/**
 * Compile an agent-generated custom source (deployment path b, brief §6).
 * The source must be self-contained except for @openzeppelin imports.
 */
export async function compileCustomSource(source: string, contractName: string): Promise<CompileArtifact> {
  const key = `custom/${contractName || "Custom"}.sol`;
  const sources: Record<string, { content: string }> = {
    [`contracts/${key}`]: { content: source },
  };
  return runSolc(sources, contractName || "Custom");
}

function contractNameFromKey(key: string): string {
  const base = key.split("/").pop() ?? key;
  return base.replace(/\.sol$/, "");
}

async function runSolc(sources: Record<string, { content: string }>, contractName: string): Promise<CompileArtifact> {
  const hash = sourceSetHash(Object.entries(sources).map(([p, s]) => ({ path: p, content: s.content })));
  const cacheKey = `${hash}:${contractName}`;
  const cached = artifactCache().get(cacheKey);
  if (cached) return cached;

  const input = {
    language: "Solidity" as const,
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // viaIR: the ConditionalRelease constructor (10 condition params) and the
      // proof-submitting release() functions exceed the legacy stack model.
      // The IR pipeline handles deep stacks cleanly (same fix the protocol
      // examples' contracts would need at this arg count).
      viaIR: true,
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.gasEstimates"],
        },
      },
    },
  };

  const importCallback = (importPath: string): { contents?: string; error?: string } => {
    // Relative imports inside contracts/ (e.g. ./vendor/X.sol)
    if (importPath.startsWith("./") || importPath.startsWith("../")) {
      // solc passes already-resolved absolute-ish keys; resolve relative to the
      // file's key by taking the path as given when it starts with contracts/.
      const content = readContractFile(importPath);
      if (content != null) return { contents: content };
      return { error: `File not found: ${importPath}` };
    }
    if (importPath.startsWith("contracts/")) {
      const content = readContractFile(importPath.slice("contracts/".length));
      if (content != null) return { contents: content };
      return { error: `File not found: ${importPath}` };
    }
    if (importPath.startsWith("@")) {
      const content = readNodeModulesImport(importPath);
      if (content != null) return { contents: content };
      return { error: `Module not found: ${importPath}` };
    }
    return { error: `Unsupported import: ${importPath}` };
  };

  const solcModule = await loadSolc();
  const raw = solcModule.compile(JSON.stringify(input), { import: importCallback });
  const output = JSON.parse(raw) as SolcOutput;

  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  const warnings = (output.errors ?? [])
    .filter((e) => e.severity === "warning")
    .map((e) => e.formattedMessage ?? e.message ?? "");

  if (errors.length > 0 || !output.contracts) {
    const detail = errors
      .slice(0, 4)
      .map((e) => e.formattedMessage ?? e.message ?? "")
      .join("\n");
    throw new Error(`Solidity compilation failed:\n${detail}`);
  }

  // Find the target contract (match exact name first, else first in file).
  let chosen: { name: string; out: SolcContractOutput } | undefined;
  for (const [fileKey, contracts] of Object.entries(output.contracts)) {
    for (const [name, out] of Object.entries(contracts)) {
      if (name === contractName || !chosen) {
        if (name === contractName) {
          chosen = { name, out };
          break;
        }
        if (!chosen && fileKey.includes(contractName)) chosen = { name, out };
      }
    }
    if (chosen?.name === contractName) break;
  }
  if (!chosen) throw new Error(`Contract ${contractName} not found in compilation output`);

  const bytecodeObj = chosen.out.evm?.bytecode?.object ?? "";
  if (!bytecodeObj || bytecodeObj === "0x" + "0".repeat(2)) {
    throw new Error(`Contract ${chosen.name} compiled to empty bytecode (abstract?)`);
  }

  // solc's creation estimate: modern versions report codeDeposit + execution
  // costs separately. Under viaIR, executionCost comes back "infinite" for
  // constructors the static analyzer can't bound (decoder/proof paths), while
  // codeDepositCost stays finite — so the hierarchy is:
  //   1. totalCost finite → totalCost + 21k intrinsic base.
  //   2. codeDeposit finite → codeDeposit + 21k + 100k nominal constructor
  //      execution (documented in fee-estimate.ts; template constructors land
  //      ~90-110k in practice).
  //   3. neither → null (the card omits the fee row).
  const creation = chosen.out.evm?.gasEstimates?.creation;
  const asRecord = typeof creation === "object" && creation !== null ? (creation as Record<string, string | undefined>) : null;
  const totalRaw = typeof creation === "string" ? creation : (asRecord?.totalCost ?? null);
  const depositRaw = asRecord?.codeDepositCost ?? null;
  const totalNum = Number(totalRaw ?? "");
  const depositNum = Number(depositRaw ?? "");
  let creationGas: string | null = null;
  if (totalRaw != null && Number.isFinite(totalNum) && totalNum > 0) {
    creationGas = String(Math.ceil(totalNum) + 21_000);
  } else if (depositRaw != null && Number.isFinite(depositNum) && depositNum > 0) {
    // P5: code-deposit + 21k intrinsic is the FLOOR (a minimum bound solc
    // can prove); constructor execution adds on top and is not estimable
    // statically here. A labeled lower bound — never an invented number.
    creationGas = String(Math.ceil(depositNum) + 21_000);
  }

  // P5: solc's per-method estimates (external calls). "infinite" → null
  // (not estimable — callers omit, they never invent).
  const methodGas: Record<string, string | null> = {};
  const external = chosen.out.evm?.gasEstimates?.external;
  if (external && typeof external === "object") {
    for (const [sig, val] of Object.entries(external)) {
      if (typeof val !== "string") continue;
      const n = Number(val);
      methodGas[sig] = Number.isFinite(n) && n > 0 ? String(Math.ceil(n) + 21_000) : null;
    }
  }

  const artifact: CompileArtifact = {
    contractName: chosen.name,
    abi: chosen.out.abi ?? [],
    bytecode: `0x${bytecodeObj.startsWith("0x") ? bytecodeObj.slice(2) : bytecodeObj}`,
    deployedBytecode: `0x${(chosen.out.evm?.deployedBytecode?.object ?? "").replace(/^0x/, "")}`,
    warnings,
    sourceHash: hash,
    creationGas,
    methodGas,
  };
  artifactCache().set(cacheKey, artifact);
  return artifact;
}
