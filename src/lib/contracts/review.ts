import { compileCustomSource } from "@/lib/contracts/compile";

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — agentic contract review engine (the review_contract tool's core).
//
// Root cause being fixed: deployment preparation (prepare.ts) compiles ONCE
// and flattens every failure into a single opaque "prep_failed" string — the
// model has nothing structured to act on, so its "retry" is a blind re-send
// of the same source. This module makes the loop genuinely agentic: the model
// drafts Solidity, calls review_contract, receives line-addressed findings
// (severity, rule, message, hint), fixes them, and repeats until ready:true —
// only then does deploy_contract run.
//
// Layering (deliberate — keeps unit tests hermetic):
//   lintContractSource(source)  — PURE static half: deterministic line/regex
//                                 rules, no I/O, no solc. Tested directly.
//   sourceGateFindings(source)  — mirrors prepare.ts's custom-path acceptance
//                                 gates (size / pragma presence / version) as
//                                 findings. Mirrored, not imported: prepare.ts
//                                 speaks transport shapes ({ok,error}), this
//                                 engine consumes findings.
//   reviewContractSource(...)   — gates + lint FIRST; the solc worker only
//                                 spawns when the static pass has zero ERRORS
//                                 (warnings still compile — the model needs
//                                 solc's own view to converge). A draft with
//                                 static errors returns before any compile.
//
// Rule design constraint: `ready` requires zero errors AND zero warnings, so
// every rule must (a) point at a fixable line, (b) hint the fix, and (c) STOP
// FIRING once that fix is applied — otherwise the iterate-until-ready loop
// deadlocks. All textual detection runs against a comment/string-stripped
// "shadow" of the source (length-preserving) so tokens inside string literals
// and comments can never false-positive while line numbers stay exact.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  severity: "error" | "warning" | "info";
  /** Stable rule id, e.g. "no-tx-origin" — surfaced to the model so it can target fixes. */
  rule: string;
  /** 1-based line in the source when locatable, else null. */
  line: number | null;
  /** What is wrong (plain English, actionable). */
  message: string;
  /** HOW to fix it — one concrete sentence the model can act on. */
  hint: string;
}

export interface ContractReview {
  ok: boolean; // true when the review RAN (not necessarily passed)
  ready: boolean; // true iff compile succeeded AND zero errors AND zero warnings
  findings: ReviewFinding[];
  compileErrors: string[];
  compileWarnings: string[];
  /** Present when ready — gives the model confidence context for the deploy call. */
  artifact?: { contractName: string; creationGas: string | null; methodGasCount: number; abiEntryCount: number };
  summary: string; // one-line human summary, e.g. "NOT READY — 2 errors, 1 warning, 3 infos"
  reviewedAt: number;
}

/** Mirrors prepare.ts (R19): solc compiles are worker-serialized — reject unbounded sources BEFORE any compile work. */
const MAX_CUSTOM_SOURCE_BYTES = 128 * 1024;

// ── small helpers ────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return (i === -1 ? text : text.slice(0, i)).trim();
}

/** 1-based line number of a character index (newline-counting — same offsets in source and shadow). */
function lineOfIndex(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Blank string/char literal contents and comments with spaces — length- and
 * newline-preserving. Structural detection (braces, commas, tx.origin, .call…)
 * runs against this shadow so tokens inside strings ("tx.origin not allowed")
 * or comments can never false-positive, while line numbers stay exact.
 */
function shadowSource(source: string): string {
  const out: string[] = [];
  let i = 0;
  let mode: "code" | "string" | "char" | "line" | "block" = "code";
  while (i < source.length) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line";
        out.push("  ");
        i += 2;
      } else if (ch === "/" && next === "*") {
        mode = "block";
        out.push("  ");
        i += 2;
      } else if (ch === '"') {
        mode = "string";
        out.push(ch);
        i += 1;
      } else if (ch === "'") {
        mode = "char";
        out.push(ch);
        i += 1;
      } else {
        out.push(ch);
        i += 1;
      }
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") {
        mode = "code";
        out.push(ch);
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code";
        out.push("  ");
        i += 2;
      } else {
        out.push(ch === "\n" ? "\n" : " ");
        i += 1;
      }
      continue;
    }
    // string | char: keep the delimiters, blank the contents (escapes too).
    if (ch === "\\") {
      out.push(next === "" ? " " : "  ");
      i += next === "" ? 1 : 2;
      continue;
    }
    if ((mode === "string" && ch === '"') || (mode === "char" && ch === "'")) {
      mode = "code";
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "\n") {
      // Unterminated literal (illegal in Solidity anyway) — resync at the
      // newline instead of swallowing the rest of the file.
      mode = "code";
      out.push(ch);
      i += 1;
      continue;
    }
    out.push(" ");
    i += 1;
  }
  return out.join("");
}

// ── best-effort function-body extraction (brace-matched) ─────────────────────

interface FnBlock {
  kind: "function" | "constructor";
  /** 1-based line of the `function`/`constructor` keyword. */
  headerLine: number;
  /** 1-based line of the body's opening `{`. */
  openLine: number;
  /** Signature + modifiers text (from the keyword up to the body `{`). */
  header: string;
  /** Body text between the braces (exclusive). */
  body: string;
}

function extractFunctionBlocks(shadow: string): FnBlock[] {
  const blocks: FnBlock[] = [];
  const sigRe = /\b(?:function\s+[A-Za-z_$][\w$]*|constructor)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = sigRe.exec(shadow)) !== null) {
    // Phase 1 — walk the signature/modifiers to the body `{`, bailing on `;`:
    // body-less declarations (interfaces, abstract virtuals) must NOT swallow
    // the next function's body — that would fabricate cross-function findings.
    let i = m.index + m[0].length;
    let paren = 1; // we start right after the signature's opening `(`
    let braceIdx = -1;
    while (i < shadow.length) {
      const ch = shadow[i];
      if (ch === "(") paren++;
      else if (ch === ")") paren--;
      else if (paren <= 0) {
        if (ch === "{") {
          braceIdx = i;
          break;
        }
        if (ch === ";") break;
      }
      i++;
    }
    if (braceIdx < 0) continue;
    // Phase 2 — brace-match the body. Unbalanced (EOF before close) → skip
    // silently: the function-scoped rules must never fire on unparseable code.
    let depth = 0;
    let end = -1;
    for (let j = braceIdx; j < shadow.length; j++) {
      const c = shadow[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    blocks.push({
      kind: m[0].startsWith("constructor") ? "constructor" : "function",
      headerLine: lineOfIndex(shadow, m.index),
      openLine: lineOfIndex(shadow, braceIdx),
      header: shadow.slice(m.index, braceIdx),
      body: shadow.slice(braceIdx + 1, end),
    });
    sigRe.lastIndex = end + 1;
  }
  return blocks;
}

/** Parameter-list text of a header (`constructor(address _owner) ` → `address _owner`). */
function paramListOf(header: string): string {
  const open = header.indexOf("(");
  if (open < 0) return "";
  let depth = 1;
  for (let i = open + 1; i < header.length; i++) {
    const c = header[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return header.slice(open + 1, i);
    }
  }
  return header.slice(open + 1);
}

// ── rule primitives ──────────────────────────────────────────────────────────

/** Top-level commas inside a call's argument list, same line only. null = closing paren not on this line (unknown). */
function topLevelCommaCount(line: string, openIdx: number): number | null {
  let depth = 1;
  let commas = 0;
  for (let i = openIdx + 1; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return commas;
    } else if (c === "," && depth === 1) commas++;
  }
  return null;
}

// A plain assignment `=` (not ==, =>, <=, >=, !=, +=…). Used to tell "result
// captured" low-level calls from fire-and-forget ones.
const ASSIGN_OP = /(?<![!<>=+\-*/%&|^])=(?!=|>)/;

// Call is checked inline (require/assert/if wraps it).
const INLINE_CHECKED = /\b(?:require|assert|if)\s*\(/;

// External/low-level call shapes (reentrancy-relevant): .call/.send always,
// .transfer/.transferFrom of any arity — an ERC-20 payout is just as external.
const EXTERNAL_CALL = /\.call\s*[{(]|\.send\s*\(|\.transfer\s*\(|\.transferFrom\s*\(/;

// State mutation on a line: `x = …`, `balances[msg.sender] -= …`, `count++`,
// `delete arr[i]`. Declarations (`uint x = …` = TWO identifiers before the
// operator) and require/if/emit statements structurally cannot match.
const STATE_MUTATION =
  /^\s*(?:delete\s+[A-Za-z_$][\w$.]*(?:\s*\[[^\]]*\])?|[A-Za-z_$][\w$.]*(?:\s*\[[^\]]*\])?\s*(?:\+=|-=|\*=|\/=|=(?!=|>)|\+\+|--))/;

// Constructor/store of a role-ish address with no zero-check anywhere. `to` is
// matched as an exact word only — a prefix match would drag in `token`-style
// names (spec's regex intent, minus that foot-gun).
const ROLE_ADDRESS = /^(owner|beneficiary|recipient|spender|arbiter|initialHolder|payer|payee)/i;

// ── lint rules (all pure; line numbers are 1-based against the original) ─────

function lintMissingSpdx(rawLines: string[]): ReviewFinding[] {
  // SPDX is itself a comment, so this check reads the RAW source — the shadow
  // would blank it out.
  const head = rawLines.slice(0, 10);
  if (head.some((l) => l.includes("SPDX-License-Identifier:"))) return [];
  return [
    {
      severity: "warning",
      rule: "missing-spdx",
      line: 1,
      message: "No SPDX license identifier in the first lines of the file.",
      hint: "Add `// SPDX-License-Identifier: MIT` as the first line.",
    },
  ];
}

function lintFloatingPragma(shadow: string): ReviewFinding[] {
  const m = /\bpragma\s+solidity\s+([^;\n]+)/.exec(shadow);
  if (!m) return [];
  const spec = m[1].trim();
  if (!spec.includes(">=") || spec.includes("<")) return [];
  return [
    {
      severity: "warning",
      rule: "floating-pragma",
      line: lineOfIndex(shadow, m.index),
      message: `Floating pragma "${spec}" — no upper bound on the compiler version.`,
      hint: "Pin like `^0.8.23` or `>=0.8.23 <0.9.0` so a future breaking solc release can never compile this contract differently.",
    },
  ];
}

function lintTxOrigin(shadowLines: string[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (let i = 0; i < shadowLines.length; i++) {
    if (/\btx\s*\.\s*origin\b/.test(shadowLines[i])) {
      out.push({
        severity: "error",
        rule: "no-tx-origin",
        line: i + 1,
        message: "tx.origin used — phishing can trick a user into a transaction where tx.origin differs from msg.sender.",
        hint: "Use `msg.sender` for authorization checks, never `tx.origin`.",
      });
    }
  }
  return out;
}

function lintDelegatecall(shadowLines: string[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (let i = 0; i < shadowLines.length; i++) {
    if (/\.delegatecall\s*\(/.test(shadowLines[i])) {
      out.push({
        severity: "error",
        rule: "no-delegatecall",
        line: i + 1,
        message: "delegatecall executes arbitrary code in this contract's storage context.",
        hint: "Remove the untrusted delegatecall — if a proxy pattern is genuinely required, say so and pin the target explicitly.",
      });
    }
  }
  return out;
}

function lintSelfdestruct(shadowLines: string[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (let i = 0; i < shadowLines.length; i++) {
    if (/\bselfdestruct\s*\(|\bsuicide\s*\(/.test(shadowLines[i])) {
      out.push({
        severity: "error",
        rule: "no-selfdestruct",
        line: i + 1,
        message: "selfdestruct destroys the contract and strands/rugs its balance — a classic exit scam vector.",
        hint: "Remove the selfdestruct path; if the user explicitly asked for one, surface it to them for a manual decision instead.",
      });
    }
  }
  return out;
}

function lintAssembly(shadowLines: string[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  // `assembly {` and the memory-safe form `assembly "memory-safe" {` (string
  // contents are blanked in the shadow — quotes remain, hence [^"]*).
  for (let i = 0; i < shadowLines.length; i++) {
    if (/\bassembly\s*(?:"[^"]*"\s*)?\{/.test(shadowLines[i])) {
      out.push({
        severity: "warning",
        rule: "no-assembly",
        line: i + 1,
        message: "Inline assembly block — assembly is exempt from Solidity's safety checks.",
        hint: "Avoid inline assembly unless strictly required; if required, add a comment justifying it.",
      });
    }
  }
  return out;
}

function lintUncheckedLowLevelCalls(shadowLines: string[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (let i = 0; i < shadowLines.length; i++) {
    const line = shadowLines[i];
    // Priority .call > .send > 1-arg .transfer; at most ONE finding per line.
    const callM = /\.call\s*[{(]/.exec(line);
    const sendM = callM ? null : /\.send\s*\(/.exec(line);
    const transferM = callM || sendM ? null : /\.transfer\s*\(/.exec(line);
    let kind: "call" | "send" | "transfer" | null = null;
    let matchIdx = -1;
    if (callM) {
      kind = "call";
      matchIdx = callM.index;
    } else if (sendM) {
      kind = "send";
      matchIdx = sendM.index;
    } else if (transferM) {
      // `.transfer(x)` with ONE argument is the native-value send; two or more
      // arguments is the ERC-20 shape (`token.transfer(to, amount)`) — a
      // high-level call, not a low-level one. Unknown (multi-line) → skip:
      // this rule must not false-positive.
      const commas = topLevelCommaCount(line, transferM.index + transferM[0].length);
      if (commas === 0) {
        kind = "transfer";
        matchIdx = transferM.index;
      }
    }
    if (!kind) continue;
    // Convergent "checked" escape hatches: the call is wrapped in
    // require/assert/if, or its result is captured on the same line.
    const assigned = ASSIGN_OP.exec(line);
    const captured = assigned !== null && assigned.index < matchIdx;
    if (INLINE_CHECKED.test(line) || captured) continue;
    if (kind === "call") {
      out.push({
        severity: "warning",
        rule: "unchecked-low-level-call",
        line: i + 1,
        message: "Low-level `.call` — its success and returned data are unchecked.",
        hint: "Capture and check the result: `(bool ok, bytes memory ret) = target.call{value: v}(\"\"); require(ok, \"call failed\");`",
      });
    } else if (kind === "send") {
      out.push({
        severity: "warning",
        rule: "unchecked-low-level-call",
        line: i + 1,
        message: "`.send` return value ignored — a failed send silently returns false.",
        hint: "Check the returned bool: `require(payable(x).send(amt), \"send failed\");`",
      });
    } else {
      out.push({
        severity: "warning",
        rule: "unchecked-low-level-call",
        line: i + 1,
        message: "`.transfer` forwards only 2300 gas and its outcome is unchecked.",
        hint: "Use a checked form: `require(payable(x).send(amt), \"send failed\");` or `(bool ok, ) = payable(x).call{value: amt}(\"\"); require(ok);`",
      });
    }
  }
  return out;
}

function lintReentrancy(blocks: FnBlock[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const b of blocks) {
    const bodyLines = b.body.split("\n");
    let extIdx = -1;
    for (let k = 0; k < bodyLines.length; k++) {
      if (bodyLines[k].trim() && EXTERNAL_CALL.test(bodyLines[k])) {
        extIdx = k;
        break;
      }
    }
    if (extIdx < 0) continue;
    for (let k = extIdx + 1; k < bodyLines.length; k++) {
      if (bodyLines[k].trim() && STATE_MUTATION.test(bodyLines[k])) {
        out.push({
          severity: "warning",
          rule: "reentrancy-risk",
          line: b.openLine + extIdx,
          message: "possible reentrancy: external call before state change",
          hint: "apply checks-effects-interactions: update state before external calls, or use a ReentrancyGuard",
        });
        break;
      }
    }
  }
  return out;
}

function lintUnboundedLoops(blocks: FnBlock[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const FOR_OVER_LENGTH = /\bfor\s*\(\s*uint[^)]*\.length/; // [^)] spans lines — multi-line for-headers included
  const PAYS = /transfer\s*\(|\.call\s*[{(]|\.send\s*\(/;
  for (const b of blocks) {
    const m = FOR_OVER_LENGTH.exec(b.body);
    if (!m || !PAYS.test(b.body)) continue;
    out.push({
      severity: "warning",
      rule: "unbounded-loop",
      line: b.openLine + (b.body.slice(0, m.index).split("\n").length - 1),
      message: "Unbounded loop over a dynamic array combined with transfers/calls — gas griefing / DoS vector.",
      hint: "Don't loop over unbounded storage arrays while paying out: track owed amounts per account, or cap/paginate the loop.",
    });
  }
  return out;
}

function lintZeroAddress(blocks: FnBlock[], shadow: string): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const b of blocks) {
    if (b.kind !== "constructor") continue;
    for (const pm of paramListOf(b.header).matchAll(/\baddress(?:\s+payable)?\s+([A-Za-z_$][\w$]*)/g)) {
      const name = pm[1];
      // Solidity style writes constructor params as `_owner` / `owner_` —
      // strip the decoration before matching the role-name set.
      const root = name.replace(/^_+/, "").replace(/_+$/, "");
      const roleish = ROLE_ADDRESS.test(root) || /^to$/i.test(root);
      if (!roleish) continue;
      let checked = false;
      for (const variant of new Set([name, root])) {
        const v = escapeRegExp(variant);
        const fwd = new RegExp(`\\b${v}\\s*(?:!=|==)\\s*address\\s*\\(\\s*0\\s*\\)`);
        const rev = new RegExp(`address\\s*\\(\\s*0\\s*\\)\\s*(?:!=|==)\\s*${v}\\b`);
        if (fwd.test(shadow) || rev.test(shadow)) {
          checked = true;
          break;
        }
      }
      if (!checked) {
        out.push({
          severity: "info",
          rule: "zero-address-unchecked",
          line: b.headerLine,
          message: `Constructor stores address parameter "${name}" without a zero-address check.`,
          hint: "Validate non-zero addresses in the constructor: `require(${name} != address(0), \"zero address\");` — a mistyped address silently bricks ownership.",
        });
      }
    }
  }
  return out;
}

function lintApproveRace(shadow: string): ReviewFinding[] {
  const approveM = /\bfunction\s+\w*approve\w*\s*\(/.exec(shadow);
  if (!approveM || !/\btransferFrom\s*\(/.test(shadow)) return [];
  return [
    {
      severity: "info",
      rule: "erc20-approve-race",
      line: lineOfIndex(shadow, approveM.index),
      message: "approve/transferFrom pattern — the classic allowance race (changing an allowance does not cancel one already pending).",
      hint: "Consider increaseAllowance-style patterns or document the race.",
    },
  ];
}

function lintKeccakPacked(shadowLines: string[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const packedRe = /keccak256\s*\(\s*abi\s*\.\s*encodePacked\s*\(/;
  for (let i = 0; i < shadowLines.length; i++) {
    const m = packedRe.exec(shadowLines[i]);
    if (!m) continue;
    const commas = topLevelCommaCount(shadowLines[i], m.index + m[0].length);
    if (commas == null || commas === 0) continue; // 0 args or multi-line → not provably multi-value
    out.push({
      severity: "warning",
      rule: "keccak-abi-encode-packed",
      line: i + 1,
      message: "keccak256(abi.encodePacked(...)) with multiple values — hash collision risk when any argument is dynamic (no length boundary).",
      hint: "Use abi.encode for multiple values; encodePacked is only safe for fixed-size arguments.",
    });
  }
  return out;
}

function lintEmptyFunctions(blocks: FnBlock[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (const b of blocks) {
    // Constructors are excluded: `constructor() Base(a, b) {}` is idiomatic —
    // the base-call args live in the header, so an empty body is not dead code.
    if (b.kind !== "function") continue;
    if (b.body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/[\s;]/g, "") !== "") continue;
    out.push({
      severity: "info",
      rule: "empty-function",
      line: b.headerLine,
      message: "Function body is empty.",
      hint: "Remove or implement.",
    });
  }
  return out;
}

function lintConsole(shadowLines: string[], rawLines: string[]): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  for (let i = 0; i < shadowLines.length; i++) {
    if (/\bconsole\s*\.\s*log\s*\(/.test(shadowLines[i])) {
      out.push({
        severity: "warning",
        rule: "console-log",
        line: i + 1,
        message: "Dev console.log call in contract source.",
        hint: "Remove dev console calls before deployment (they cost gas and leak internals).",
      });
    } else if (
      // The import path is a STRING literal — blanked in the shadow — so this
      // check reads the raw line.
      i < rawLines.length &&
      /^\s*import\b[^\n]*(?:\bhardhat\b|console\.sol)/.test(rawLines[i])
    ) {
      out.push({
        severity: "warning",
        rule: "console-log",
        line: i + 1,
        message: "hardhat/forge console import in contract source.",
        hint: "Remove dev console calls and their imports before deployment.",
      });
    }
  }
  return out;
}

// ── source gates (mirror of prepare.ts's custom-path acceptance) ──────────────

function sourceGateFindings(source: string): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const gate = (message: string, hint: string): void => {
    out.push({ severity: "error", rule: "source-gate", line: null, message, hint });
  };
  if (Buffer.byteLength(source, "utf8") > MAX_CUSTOM_SOURCE_BYTES) {
    gate(`Source exceeds the ${MAX_CUSTOM_SOURCE_BYTES / 1024} KB limit.`, "Split the contract or remove embedded data.");
    return out;
  }
  if (!/pragma solidity/i.test(source)) {
    gate("Source is missing a pragma directive.", "Add `pragma solidity ^0.8.23;` on the line after the SPDX identifier.");
  } else {
    if (/^\s*pragma solidity\s+[^;]*0\.[0-6]/m.test(source)) {
      gate("Solidity versions below 0.8 are not accepted (safety).", "Use `pragma solidity ^0.8.23;` — the 0.8 line's checked arithmetic is the app's supported baseline.");
    }
    if (!/^pragma solidity[^\n]*\^0\.8/m.test(source) && !/pragma solidity[^\n]*>=0\.8/m.test(source)) {
      gate("Use 'pragma solidity ^0.8.23' (or >=0.8).", "Pin the pragma: `pragma solidity ^0.8.23;` or `>=0.8.23 <0.9.0`.");
    }
  }
  return out;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * The PURE static half of the review: deterministic lint rules over the
 * source text. No I/O, no solc, no side effects — unit-testable standalone.
 * Sources above the size gate return no lint findings (the gate error already
 * decides the outcome; regex passes over megabytes of adversarial text buy
 * the model nothing).
 */
export function lintContractSource(source: string): ReviewFinding[] {
  if (Buffer.byteLength(source, "utf8") > MAX_CUSTOM_SOURCE_BYTES) return [];
  const rawLines = source.split("\n");
  const shadow = shadowSource(source);
  const shadowLines = shadow.split("\n");
  const blocks = extractFunctionBlocks(shadow);
  return [
    ...lintMissingSpdx(rawLines),
    ...lintFloatingPragma(shadow),
    ...lintTxOrigin(shadowLines),
    ...lintDelegatecall(shadowLines),
    ...lintSelfdestruct(shadowLines),
    ...lintAssembly(shadowLines),
    ...lintUncheckedLowLevelCalls(shadowLines),
    ...lintReentrancy(blocks),
    ...lintUnboundedLoops(blocks),
    ...lintZeroAddress(blocks, shadow),
    ...lintApproveRace(shadow),
    ...lintKeccakPacked(shadowLines),
    ...lintEmptyFunctions(blocks),
    ...lintConsole(shadowLines, rawLines),
  ];
}

/** Ready verdict on findings alone: zero error-severity AND zero warning-severity (info notes never block). */
export function isReady(findings: ReviewFinding[]): boolean {
  return !findings.some((f) => f.severity === "error" || f.severity === "warning");
}

/** One-line verdict summary — pure, exported for hermetic tests of the READY wording. */
export function summarizeFindings(findings: ReviewFinding[], ready: boolean): string {
  const count = (s: ReviewFinding["severity"]): number => findings.filter((f) => f.severity === s).length;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  return ready
    ? `READY — contract compiles clean, ${plural(count("warning"), "warning")}, ${plural(count("info"), "info note")}`
    : `NOT READY — ${plural(count("error"), "error")}, ${plural(count("warning"), "warning")}, ${plural(count("info"), "info")}`;
}

/**
 * Parse solc's formatted error text (the message compileCustomSource throws)
 * into digest lines + line-addressed findings. Pure — exported for hermetic
 * tests of the compile-failure path without spawning the solc worker.
 *
 * Two diagnostic shapes occur depending on solc build:
 *   classic: `contracts/custom/X.sol:6:9: DeclarationError: message`
 *   rust-style: `DeclarationError: message` on one line, then
 *               ` --> contracts/custom/X.sol:6:9:` (what solc 0.8.36 emits).
 */
export function parseSolcCompileErrors(text: string): { lines: string[]; findings: ReviewFinding[] } {
  const lines: string[] = [];
  const findings: ReviewFinding[] = [];
  // The classic diagnostic block ALSO contains a `--> file:line:col` line in
  // its source context — one real error would otherwise parse twice. Classic
  // headers are recorded by location so their own context arrows can be
  // skipped; exact (location+kind+message) dupes are dropped anywhere.
  const classicLocations = new Set<string>();
  const seen = new Set<string>();
  const rows = text.split("\n").map((r) => r.trim());
  const classicRe = /^([^\s:]+\.sol):(\d+):(\d+):\s*(\w+):\s*(.*)$/;
  const arrowRe = /^-->\s*([^\s:]+\.sol):(\d+):(\d+):?$/;
  const push = (file: string, lineNo: string, kind: string, msg: string, fromClassic: boolean): void => {
    const key = `${file}:${lineNo}:${kind}:${msg}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (fromClassic) classicLocations.add(`${file}:${lineNo}`);
    const line = Number(lineNo);
    lines.push(`${file}:${lineNo}: ${kind}: ${msg}`);
    findings.push({
      severity: "error",
      rule: "solc-error",
      line: Number.isFinite(line) && line > 0 ? line : null,
      message: `${kind}: ${msg}`,
      hint: "Fix the compiler error at that line, then call review_contract again with the corrected source.",
    });
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const classic = classicRe.exec(row);
    if (classic) {
      push(classic[1], classic[2], classic[4], classic[5], true);
      continue;
    }
    const arrow = arrowRe.exec(row);
    if (arrow) {
      if (classicLocations.has(`${arrow[1]}:${arrow[2]}`)) continue; // the classic block's own context arrow
      // Rust-style: the kind + message sit on the previous non-empty line.
      let prev = "";
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j]) {
          prev = rows[j];
          break;
        }
      }
      let kind = "CompilationError";
      let msg = prev;
      const km = /^(\w+):\s*(.*)$/.exec(prev);
      if (km && /(Error|Warning|Exception)$/i.test(km[1])) {
        kind = km[1];
        msg = km[2];
      }
      push(arrow[1], arrow[2], kind, msg, false);
    }
  }
  if (findings.length === 0) {
    // Not solc-shaped (worker crash/timeout/OOM) — still an error verdict, but
    // with a distinct hint so the model retries instead of "fixing" source
    // that isn't the problem.
    findings.push({
      severity: "error",
      rule: "solc-error",
      line: null,
      message: firstLine(text).slice(0, 200) || "Solidity compilation failed with no diagnostic.",
      hint: "The compiler itself failed (not a source error) — call review_contract again; if it keeps failing, report the message to the user.",
    });
    lines.push(text.trim().slice(0, 400));
  }
  return { lines, findings };
}

/**
 * Full review: source gates + static lint FIRST, then a real solc compile —
 * but only when the static pass has zero ERRORS (warnings still compile: the
 * model needs solc's own warnings to converge). `ready` additionally requires
 * the compile to have succeeded, so a compile-skipped review is never ready.
 */
export async function reviewContractSource(source: string, sourceName?: string): Promise<ContractReview> {
  const reviewedAt = Date.now();
  const findings: ReviewFinding[] = [...sourceGateFindings(source), ...lintContractSource(source)];
  const compileErrors: string[] = [];
  const compileWarnings: string[] = [];
  let artifact: ContractReview["artifact"];
  let compileOk = false;

  if (!findings.some((f) => f.severity === "error")) {
    // Same name sanitization as prepare.ts's custom path, so review and deploy
    // address the identical compilation unit (artifact cache keys match too).
    const name = (sourceName ?? "Custom").replace(/[^A-Za-z0-9_]/g, "") || "Custom";
    try {
      const compiled = await compileCustomSource(source, name);
      compileOk = true;
      compileWarnings.push(...compiled.warnings);
      for (const w of compiled.warnings) {
        findings.push({
          severity: "warning",
          rule: "solc-warning",
          line: null,
          message: firstLine(w) || "Compiler warning (empty message).",
          hint: "Fix the compiler warning — readiness requires zero warnings — then call review_contract again.",
        });
      }
      artifact = {
        contractName: compiled.contractName,
        creationGas: compiled.creationGas,
        methodGasCount: Object.keys(compiled.methodGas).length,
        abiEntryCount: Array.isArray(compiled.abi) ? compiled.abi.length : 0,
      };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      const parsed = parseSolcCompileErrors(text);
      compileErrors.push(...parsed.lines);
      findings.push(...parsed.findings);
    }
  }

  const ready = compileOk && isReady(findings);
  return {
    ok: true, // the review RAN — findings (even failures) are its product, not errors of the tool
    ready,
    findings,
    compileErrors,
    compileWarnings,
    artifact,
    summary: summarizeFindings(findings, ready),
    reviewedAt,
  };
}
