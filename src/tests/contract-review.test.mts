// ─────────────────────────────────────────────────────────────────────────────
// AC4 review-engine unit tests (pure logic only — no solc compile is EVER
// spawned here):
//   lintContractSource / isReady / summarizeFindings / parseSolcCompileErrors
//     are exercised directly (the pure static half of the engine).
//   reviewContractSource is exercised ONLY with sources that carry a static
//     ERROR (lint or source-gate) — by design the engine returns BEFORE
//     compiling in that case, so the tests stay hermetic (no worker, no
//     node_modules/solc dependency).
// Import style mirrors attestcoin-gaps.test.mts (dynamic `@/`-alias imports
// resolved by tsx from tsconfig paths).
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ReviewFinding } from "@/lib/contracts/review";

const { lintContractSource, reviewContractSource, isReady, summarizeFindings, parseSolcCompileErrors } = await import(
  "@/lib/contracts/review"
);

const findingOf = (findings: ReviewFinding[], rule: string): ReviewFinding[] => findings.filter((f) => f.rule === rule);

const mkFinding = (severity: ReviewFinding["severity"]): ReviewFinding => ({
  severity,
  rule: "test-rule",
  line: 1,
  message: "m",
  hint: "h",
});

// ─── clean sources ────────────────────────────────────────────────────────────

describe("AC4 lint — clean sources stay silent", () => {
  test("minimal clean contract (SPDX + pinned pragma) → zero findings", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Counter {
    uint256 public count;
    function increment() external {
        count += 1;
    }
}`;
    assert.deepEqual(lintContractSource(source), []);
  });

  test("range-pinned pragma (>=0.8.23 <0.9.0) is not floating", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity >=0.8.23 <0.9.0;

contract Ranged {
    uint256 public v;
}`;
    assert.deepEqual(lintContractSource(source), []);
  });

  test("constructor address param WITH a zero-check → no zero-address finding", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Safe {
    address public owner;
    constructor(address _owner) {
        require(_owner != address(0), "zero address");
        owner = _owner;
    }
}`;
    assert.deepEqual(lintContractSource(source), []);
  });

  test("tokens inside strings and comments never false-positive", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Comments {
    // tx.origin and selfdestruct( are mentioned here in a comment
    function note() external pure returns (string memory) {
        return "tx.origin == owner, please ignore selfdestruct(";
    }
}`;
    assert.deepEqual(lintContractSource(source), []);
  });
});

// ─── single-rule precision (line numbers, severity, hints) ────────────────────

describe("AC4 lint — single-rule precision", () => {
  test("missing-spdx fires as a warning and its hint says exactly what to add", () => {
    const source = `pragma solidity ^0.8.23;

contract NoSpdx {
    uint256 public x;
}`;
    const findings = lintContractSource(source);
    assert.equal(findings.length, 1);
    const f = findings[0];
    assert.equal(f.rule, "missing-spdx");
    assert.equal(f.severity, "warning");
    assert.equal(f.line, 1);
    assert.ok(f.hint.includes("SPDX-License-Identifier: MIT"), `hint should name the SPDX line: ${f.hint}`);
  });

  test("floating-pragma (>= without <) fires at the pragma line; ^0.8 does not", () => {
    const floating = `// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

contract Flo {
    uint256 public v;
}`;
    const findings = lintContractSource(floating);
    const fp = findingOf(findings, "floating-pragma");
    assert.equal(fp.length, 1);
    assert.equal(fp[0].severity, "warning");
    assert.equal(fp[0].line, 2);
    assert.ok(fp[0].hint.includes("^0.8"));

    const pinned = floating.replace(">=0.8.0", "^0.8.23");
    assert.deepEqual(findingOf(lintContractSource(pinned), "floating-pragma"), []);
  });

  test("no-tx-origin is an error with the exact line number", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Gate {
    address public owner;
    constructor() { owner = msg.sender; }
    function sensitive() external {
        require(tx.origin == owner, "not owner");
    }
}`;
    const findings = lintContractSource(source);
    const t = findingOf(findings, "no-tx-origin");
    assert.equal(t.length, 1);
    assert.equal(t[0].severity, "error");
    assert.equal(t[0].line, 8);
    assert.ok(t[0].hint.includes("msg.sender"));
  });

  test("no-delegatecall / no-selfdestruct are errors on their lines", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Danger {
    function run(address target, bytes memory data) external {
        target.delegatecall(data);
        selfdestruct(payable(msg.sender));
    }
}`;
    const findings = lintContractSource(source);
    const d = findingOf(findings, "no-delegatecall");
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, "error");
    assert.equal(d[0].line, 6);
    const s = findingOf(findings, "no-selfdestruct");
    assert.equal(s.length, 1);
    assert.equal(s[0].severity, "error");
    assert.equal(s[0].line, 7);
  });

  test("no-assembly warns on `assembly {` blocks", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Asm {
    function f() external pure {
        assembly {
            let x := 1
        }
    }
}`;
    const a = findingOf(lintContractSource(source), "no-assembly");
    assert.equal(a.length, 1);
    assert.equal(a[0].severity, "warning");
    assert.equal(a[0].line, 6);
  });

  test("unchecked-low-level-call: bare .call fires; captured/required/ERC-20 forms do not", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Calls {
    function captured() external {
        (bool ok, ) = msg.sender.call("");
        require(ok, "call failed");
    }
    function erc20(address token, address to, uint256 amt) external {
        token.transfer(to, amt);
    }
    function sent() external {
        require(payable(msg.sender).send(1), "send failed");
    }
    function bare() external {
        payable(msg.sender).call{value: 1}("");
    }
}`;
    const findings = lintContractSource(source);
    const u = findingOf(findings, "unchecked-low-level-call");
    assert.equal(u.length, 1, `expected exactly one unchecked call finding, got: ${JSON.stringify(u)}`);
    assert.equal(u[0].line, 16);
    assert.equal(u[0].severity, "warning");
  });

  test("reentrancy-risk: external call before a later state mutation in the same function", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Bad {
    mapping(address => uint256) public balances;
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        payable(msg.sender).transfer(amount);
        balances[msg.sender] -= amount;
    }
}`;
    // NOTE: line 8's transfer is unchecked (fires unchecked-low-level-call) AND
    // line 9 mutates state after it (fires reentrancy-risk) — two different
    // rules on adjacent lines, both pointing at the interaction.
    const findings = lintContractSource(source);
    const r = findingOf(findings, "reentrancy-risk");
    assert.equal(r.length, 1);
    assert.equal(r[0].severity, "warning");
    assert.equal(r[0].line, 8);
    assert.ok(r[0].hint.includes("checks-effects-interactions"));
  });

  test("reentrancy-risk: checks-effects-interactions ordering stays silent", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Good {
    mapping(address => uint256) public balances;
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        balances[msg.sender] -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "send failed");
    }
}`;
    const r = findingOf(lintContractSource(source), "reentrancy-risk");
    assert.deepEqual(r, []);
  });

  test("zero-address-unchecked: role-named constructor address param without check (info)", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Owned {
    address public owner;
    constructor(address _owner) {
        owner = _owner;
    }
}`;
    const z = findingOf(lintContractSource(source), "zero-address-unchecked");
    assert.equal(z.length, 1);
    assert.equal(z[0].severity, "info");
    assert.equal(z[0].line, 6);
    assert.ok(z[0].hint.includes("address(0)"));
  });

  test("unbounded-loop: for(uint … .length) + transfer in one function warns; a bounded loop does not", () => {
    const unbounded = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract PayAll {
    address[] public users;
    function payoutAll() external {
        for (uint256 i = 0; i < users.length; i++) {
            payable(users[i]).transfer(1);
        }
    }
}`;
    const findings = lintContractSource(unbounded);
    const l = findingOf(findings, "unbounded-loop");
    assert.equal(l.length, 1);
    assert.equal(l[0].severity, "warning");
    assert.equal(l[0].line, 7);

    const bounded = unbounded.replace("i < users.length", "i < 10");
    assert.deepEqual(findingOf(lintContractSource(bounded), "unbounded-loop"), []);
  });

  test("erc20-approve-race: approve + transferFrom in one contract → single info", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Token {
    mapping(address => uint256) public allowances;
    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowances[from] -= amount;
        return true;
    }
}`;
    const findings = lintContractSource(source);
    const a = findingOf(findings, "erc20-approve-race");
    assert.equal(a.length, 1);
    assert.equal(a[0].severity, "info");
    assert.equal(a[0].line, 6);
    assert.ok(a[0].hint.includes("increaseAllowance") || a[0].hint.includes("document the race"));
  });

  test("keccak-abi-encode-packed: multiple values warn; single value does not", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Hash {
    function digest(address a, uint256 b) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }
    function one(address a) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(a));
    }
}`;
    const k = findingOf(lintContractSource(source), "keccak-abi-encode-packed");
    assert.equal(k.length, 1);
    assert.equal(k[0].severity, "warning");
    assert.equal(k[0].line, 6);
    assert.ok(k[0].hint.includes("abi.encode"));
  });

  test("empty-function: `{}` / `{ ; }` bodies are info findings; constructors are exempt", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Voids {
    constructor() {}
    function nothing() external {}
    function semi() external { ; }
}`;
    const e = findingOf(lintContractSource(source), "empty-function");
    assert.equal(e.length, 2); // constructor() {} deliberately not flagged
    assert.deepEqual(
      e.map((f) => f.line).sort((x, y) => (x ?? 0) - (y ?? 0)),
      [6, 7],
    );
    assert.equal(e[0].severity, "info");
  });

  test("console-log: calls and the hardhat console import both warn", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "hardhat/console.sol";

contract Noisy {
    function run() external {
        console.log("hi");
    }
}`;
    const c = findingOf(lintContractSource(source), "console-log");
    assert.equal(c.length, 2);
    assert.deepEqual(
      c.map((f) => f.line).sort((x, y) => (x ?? 0) - (y ?? 0)),
      [4, 8],
    );
    assert.equal(c[0].severity, "warning");
  });
});

// ─── multiple findings, dedupe, ordering ──────────────────────────────────────

describe("AC4 lint — multiple findings & dedupe", () => {
  test("two tx.origin occurrences on the SAME line dedupe to one finding; separate lines do not", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Dup {
    function twice() external view {
        bool both = tx.origin == msg.sender && tx.origin != address(0);
    }
    function other() external view {
        bool one = tx.origin == msg.sender;
    }
}`;
    const t = findingOf(lintContractSource(source), "no-tx-origin");
    assert.equal(t.length, 2);
    assert.deepEqual(
      t.map((f) => f.line).sort((x, y) => (x ?? 0) - (y ?? 0)),
      [6, 9],
    );
  });

  test("kitchen-sink contract: every rule fires at its exact line", () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "hardhat/console.sol";

contract Sink {
    address public owner;
    mapping(address => uint256) public balances;
    address[] public users;

    constructor(address _owner) {
        owner = _owner;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "insufficient");
        payable(msg.sender).transfer(amount);
        balances[msg.sender] -= amount;
    }

    function payoutAll() external {
        for (uint256 i = 0; i < users.length; i++) {
            payable(users[i]).transfer(balances[users[i]]);
        }
    }

    function digest(address to, uint256 v) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(to, v));
    }

    function run(bytes memory data) external {
        address target = owner;
        target.call(data);
        assembly { let x := 1 }
        selfdestruct(payable(owner));
    }

    function touch() external {
        console.log("hi");
        if (tx.origin == owner) { owner = msg.sender; }
    }
}
`;
    const findings = lintContractSource(source);
    const at = (rule: string, line: number): void => {
      assert.ok(
        findings.some((f) => f.rule === rule && f.line === line),
        `expected ${rule} @ line ${line}; got ${JSON.stringify(findings.map((f) => [f.rule, f.line]))}`,
      );
    };
    at("floating-pragma", 2);
    at("console-log", 4);
    at("zero-address-unchecked", 11);
    at("reentrancy-risk", 17);
    at("unchecked-low-level-call", 17);
    at("unbounded-loop", 22);
    at("unchecked-low-level-call", 23);
    at("keccak-abi-encode-packed", 28);
    at("unchecked-low-level-call", 33);
    at("no-assembly", 34);
    at("no-selfdestruct", 35);
    at("console-log", 39);
    at("no-tx-origin", 40);
    // Severity census: 2 errors, 10 warnings, 1 info.
    const bySeverity = (s: ReviewFinding["severity"]): number => findings.filter((f) => f.severity === s).length;
    assert.equal(bySeverity("error"), 2);
    assert.equal(bySeverity("warning"), 10);
    assert.equal(bySeverity("info"), 1);
  });
});

// ─── verdict computation ──────────────────────────────────────────────────────

describe("AC4 verdict — isReady / summarizeFindings", () => {
  test("isReady: only zero errors AND zero warnings is ready (info never blocks)", () => {
    assert.equal(isReady([]), true);
    assert.equal(isReady([mkFinding("info")]), true);
    assert.equal(isReady([mkFinding("info"), mkFinding("info")]), true);
    assert.equal(isReady([mkFinding("warning")]), false);
    assert.equal(isReady([mkFinding("error")]), false);
    assert.equal(isReady([mkFinding("info"), mkFinding("warning"), mkFinding("error")]), false);
  });

  test("summarizeFindings wording (what the model reads)", () => {
    assert.equal(summarizeFindings([], true), "READY — contract compiles clean, 0 warnings, 0 info notes");
    assert.equal(
      summarizeFindings([mkFinding("info"), mkFinding("info")], true),
      "READY — contract compiles clean, 0 warnings, 2 info notes",
    );
    assert.equal(summarizeFindings([mkFinding("error")], false), "NOT READY — 1 error, 0 warnings, 0 infos");
    assert.equal(
      summarizeFindings([mkFinding("error"), mkFinding("error"), mkFinding("warning"), mkFinding("info"), mkFinding("info"), mkFinding("info")], false),
      "NOT READY — 2 errors, 1 warning, 3 infos",
    );
  });

  test("lint-only path: warnings alone → not ready", () => {
    const warningOnly = lintContractSource("pragma solidity ^0.8.23;\ncontract W { function f() external { payable(msg.sender).transfer(1); } }");
    assert.ok(warningOnly.some((f) => f.severity === "warning"));
    assert.equal(warningOnly.some((f) => f.severity === "error"), false);
    assert.equal(isReady(warningOnly), false);
  });
});

// ─── the full review (hermetic: static errors → returns BEFORE compiling) ─────

describe("AC4 reviewContractSource — static-error path (no solc involved)", () => {
  test("tx.origin draft: ok, not ready, exact line, no artifact, compile skipped", async () => {
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Gate {
    address public owner;
    constructor() { owner = msg.sender; }
    function sensitive() external {
        require(tx.origin == owner, "not owner");
    }
}`;
    const review = await reviewContractSource(source, "Gate");
    assert.equal(review.ok, true); // the review RAN — findings are its product
    assert.equal(review.ready, false);
    assert.deepEqual(review.compileErrors, []); // compile skipped: static errors present
    assert.equal(review.artifact, undefined);
    const t = findingOf(review.findings, "no-tx-origin");
    assert.equal(t.length, 1);
    assert.equal(t[0].line, 8);
    assert.equal(review.summary, "NOT READY — 1 error, 0 warnings, 0 infos");
  });

  test("source-gate: missing pragma → error finding, compile never attempted", async () => {
    const review = await reviewContractSource("contract X { function f() public {} }", "X");
    assert.equal(review.ok, true);
    assert.equal(review.ready, false);
    assert.deepEqual(review.compileErrors, []);
    const gates = findingOf(review.findings, "source-gate");
    assert.equal(gates.length, 1); // missing pragma (the version-style gate is vacuous without one)
    assert.equal(gates[0].severity, "error");
    assert.equal(review.summary, "NOT READY — 1 error, 1 warning, 1 info"); // + missing-spdx warning + empty-function info
  });

  test("source-gate: pre-0.8 pragma rejected (0.7 fails the version-style gate)", async () => {
    const review = await reviewContractSource(
      "// SPDX-License-Identifier: MIT\npragma solidity 0.7.0;\ncontract Old {}",
      "Old",
    );
    const gates = findingOf(review.findings, "source-gate");
    assert.equal(gates.length, 1);
    assert.equal(gates[0].severity, "error");
    assert.equal(review.ready, false);
  });
});

// ─── solc error-text parsing (pure — no worker needed) ────────────────────────

describe("AC4 parseSolcCompileErrors — the compile-failure bridge", () => {
  test("solc-formatted text becomes line-addressed error findings + digest lines", () => {
    const thrown = `Solidity compilation failed:
contracts/custom/Broken.sol:3:32: DeclarationError: Undeclared identifier. Did you mean "greeting"?
  --> contracts/custom/Broken.sol:3:32:
   |
3 |     function f() { undefinedCall(); }
   |                                ^^^^^^^^^^^^^

`;
    const parsed = parseSolcCompileErrors(thrown);
    assert.equal(parsed.findings.length, 1);
    const f = parsed.findings[0];
    assert.equal(f.rule, "solc-error");
    assert.equal(f.severity, "error");
    assert.equal(f.line, 3);
    assert.ok(f.message.startsWith("DeclarationError:"));
    assert.ok(f.hint.includes("review_contract"));
    assert.equal(parsed.lines.length, 1);
    assert.ok(parsed.lines[0].startsWith("contracts/custom/Broken.sol:3: DeclarationError:"));
  });

  test("rust-style solc diagnostics (the shape solc 0.8.36 actually throws) parse with line numbers", () => {
    // Verbatim shape observed from compileCustomSource via the installed solc:
    // kind+message on one line, ` --> file:line:col:` on the next.
    const thrown = `Solidity compilation failed:
DeclarationError: Undeclared identifier.
 --> contracts/custom/Broken.sol:6:9:
  |
6 |         undefinedCall();
  |         ^^^^^^^^^^^^^`;
    const parsed = parseSolcCompileErrors(thrown);
    assert.equal(parsed.findings.length, 1);
    const f = parsed.findings[0];
    assert.equal(f.rule, "solc-error");
    assert.equal(f.severity, "error");
    assert.equal(f.line, 6);
    assert.equal(f.message, "DeclarationError: Undeclared identifier.");
    assert.ok(f.hint.includes("review_contract"));
    assert.equal(parsed.lines.length, 1);
    assert.equal(parsed.lines[0], "contracts/custom/Broken.sol:6: DeclarationError: Undeclared identifier.");
  });

  test("non-solc failure text (worker crash) still yields an error finding with a retry hint", () => {
    const parsed = parseSolcCompileErrors("Solidity worker crashed: OOM");
    assert.equal(parsed.findings.length, 1);
    const f = parsed.findings[0];
    assert.equal(f.rule, "solc-error");
    assert.equal(f.severity, "error");
    assert.equal(f.line, null);
    assert.ok(f.message.includes("worker crashed"));
    assert.ok(f.hint.includes("again"));
  });
});
