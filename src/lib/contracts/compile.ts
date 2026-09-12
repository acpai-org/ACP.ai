import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";

// ─────────────────────────────────────────────────────────────────────────────
// Solidity compilation service (server-side only).
//
// Compiles the in-repo contracts (contracts/) + template library with solc-js
// in ONE invocation so the vendored EvmV1Decoder (internal visibility) INLINES
// into every ASC — no library deployment, no linking (decision logged in the
// worklog). @openzeppelin imports resolve from node_modules.
//
// Artifacts are cached by the source-set hash (compiles are deterministic).
//
// R22 (round 4): the solc invocation now runs inside a dedicated worker
// thread. solc-js compile() is synchronous and CPU-heavy — viaIR compiles
// take seconds and can take a minute+ — and in-process it froze the entire
// Node event loop for the duration, stalling every concurrent request, SSE
// stream and poller tick. The worker additionally isolates failures (a solc
// OOM/crash used to take the whole server down; now exactly one request
// fails with a clear error) and keeps the multi-MB soljson module out of the
// main server heap. The worker is spawned from an eval-mode source string
// ON PURPOSE: bundlers (turbopack/webpack) never see it, and solc is loaded
// at runtime from the real node_modules path via createRequire — zero
// bundler interference. Compiles are serialized (mirroring the old sync
// behavior and bounding worst-case worker memory to one live worker) and
// deduplicated per source-set hash while in flight.
// ─────────────────────────────────────────────────────────────────────────────

const G = globalThis as unknown as {
  __acpArtifactCache?: Map<string, CompileArtifact>;
  __acpSolcInflight?: Map<string, Promise<CompileArtifact>>;
};

function artifactCache(): Map<string, CompileArtifact> {
  if (!G.__acpArtifactCache) G.__acpArtifactCache = new Map();
  return G.__acpArtifactCache;
}

function inFlight(): Map<string, Promise<CompileArtifact>> {
  if (!G.__acpSolcInflight) G.__acpSolcInflight = new Map();
  return G.__acpSolcInflight;
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

// ── Worker plumbing ──────────────────────────────────────────────────────────
//
// The worker replicates the import-resolution logic (contracts/ relative
// imports + node_modules @-imports) with fs access of its own, cwd being
// passed in workerData. It must stay behaviorally in sync with
// readContractFile() above — both guard the same way against traversal.

/**
 * Eval-mode worker source. Runs as the worker's main script in any context
 * (all node built-ins are pulled via dynamic import, which works from both
 * CJS and ESM entry styles). Posts exactly one message back:
 *   { ok: true, raw: <solc JSON output string> } on success
 *   { ok: false, error: <stack string> } on failure
 */
const SOLC_WORKER_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import("node:worker_threads");
  try {
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const CONTRACTS_ROOT = path.join(workerData.cwd, "contracts");
    const NODE_MODULES_ROOT = path.join(workerData.cwd, "node_modules");
    function readContractFile(relPath) {
      const normalized = String(relPath).split("\\\\").join("/");
      if (normalized.includes("..")) return null;
      const base = normalized.startsWith("contracts/") ? normalized : "contracts/" + normalized;
      const abs = path.join(workerData.cwd, base);
      if (!abs.startsWith(CONTRACTS_ROOT)) return null;
      if (!fs.existsSync(abs)) return null;
      try { return fs.readFileSync(abs, "utf8"); } catch { return null; }
    }
    function readNodeModulesImport(spec) {
      const abs = path.join(workerData.cwd, "node_modules", spec);
      if (!abs.includes(NODE_MODULES_ROOT)) return null;
      if (!fs.existsSync(abs)) return null;
      try { return fs.readFileSync(abs, "utf8"); } catch { return null; }
    }
    const importCallback = (importPath) => {
      if (importPath.startsWith("./") || importPath.startsWith("../")) {
        const content = readContractFile(importPath);
        if (content != null) return { contents: content };
        return { error: "File not found: " + importPath };
      }
      if (importPath.startsWith("contracts/")) {
        const content = readContractFile(importPath.slice("contracts/".length));
        if (content != null) return { contents: content };
        return { error: "File not found: " + importPath };
      }
      if (importPath.startsWith("@")) {
        const content = readNodeModulesImport(importPath);
        if (content != null) return { contents: content };
        return { error: "Module not found: " + importPath };
      }
      return { error: "Unsupported import: " + importPath };
    };
    const mod = await import(pathToFileURL(workerData.solcEntry).href);
    const solc = mod.default && typeof mod.default.compile === "function" ? mod.default : mod;
    const raw = solc.compile(workerData.inputJson, { import: importCallback });
    parentPort.postMessage({ ok: true, raw });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
})();
`;

/** Hard ceiling for one compilation. Previously a stuck compile froze the
 *  server forever; now the worker is terminated and the request fails loud. */
const SOLC_WORKER_TIMEOUT_MS = 240_000;

/** Worker V8 heap cap — a runaway compile dies inside the worker (one failed
 *  request) instead of OOM-killing the whole server process. Generous vs the
 *  few-hundred-MB legit viaIR compiles actually need. */
const SOLC_WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 768 };

let solcEntryCache: string | null = null;
function solcEntry(): string {
  if (solcEntryCache) return solcEntryCache;
  // Resolve from the REAL node_modules on disk (bundler-independent — works
  // identically under the Next.js server bundle and plain node/tsx tests).
  const req = createRequire(path.join(process.cwd(), "package.json"));
  solcEntryCache = req.resolve("solc");
  return solcEntryCache;
}

function runSolcWorker(inputJson: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(SOLC_WORKER_SOURCE, {
        eval: true,
        workerData: { cwd: process.cwd(), inputJson, solcEntry: solcEntry() },
        resourceLimits: SOLC_WORKER_RESOURCE_LIMITS,
      });
    } catch (err) {
      reject(new Error(`Solidity worker spawn failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error(`Solidity compilation exceeded ${SOLC_WORKER_TIMEOUT_MS / 1000}s — worker terminated`));
    }, SOLC_WORKER_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // One-shot worker: always tear it down once we have our answer.
      void worker.terminate();
      fn();
    };
    worker.on("message", (msg: unknown) => {
      const m = msg as { ok?: boolean; raw?: unknown; error?: unknown };
      finish(() => {
        if (m && m.ok === true && typeof m.raw === "string") {
          resolve(m.raw);
        } else {
          reject(new Error(`Solidity worker failed: ${typeof m?.error === "string" ? m.error : "no output"}`));
        }
      });
    });
    worker.on("error", (err) => {
      finish(() => reject(new Error(`Solidity worker crashed: ${err instanceof Error ? err.message : String(err)}`)));
    });
    worker.on("exit", (code) => {
      finish(() => reject(new Error(`Solidity worker exited before reporting (code ${code})`)));
    });
  });
}

// Compile serialization: a promise chain mirroring the old fully-synchronous
// behavior (one compile at a time) — bounds worst-case worker memory to a
// single live solc instance.
let compileChain: Promise<unknown> = Promise.resolve();
function enqueueCompile<T>(fn: () => Promise<T>): Promise<T> {
  const run = compileChain.then(fn, fn);
  compileChain = run.catch(() => {
    /* errors propagate to the caller; the chain stays runnable */
  });
  return run;
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
  const inflight = inFlight().get(cacheKey);
  if (inflight) return inflight;

  const job = enqueueCompile(() => compileInWorker(sources, hash, contractName));
  inFlight().set(cacheKey, job);
  try {
    return await job;
  } finally {
    inFlight().delete(cacheKey);
  }
}

async function compileInWorker(
  sources: Record<string, { content: string }>,
  hash: string,
  contractName: string,
): Promise<CompileArtifact> {
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

  const raw = await runSolcWorker(JSON.stringify(input));
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
  artifactCache().set(`${hash}:${contractName}`, artifact);
  return artifact;
}
