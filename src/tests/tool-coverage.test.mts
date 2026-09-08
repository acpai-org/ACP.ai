// ─────────────────────────────────────────────────────────────────────────────
// Tool coverage suite (P26 campaign): every tool in the closed registry is
// structurally valid, dispatchable (server switch or client switch), parses a
// realistic agent call through its zod schema, has a trace label, and that
// label exists in all four i18n dictionaries.
//
// This is the guard against the "bugged tools" class: a tool whose name
// drifted from its dispatch case, whose schema rejects the shape the model
// actually emits, or whose trace label was never localized — each previously
// produced runtime surprises (the P11 "Unsupported chain undefined" family).
//
// Runs from the repo root (same contract as contracts-compile.test.mts):
// source files are read via process.cwd() for the dispatch/label checks.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const { TOOL_REGISTRY } = await import("@/lib/agent/tool-registry");
const { en } = await import("@/lib/i18n/en");
const { zh } = await import("@/lib/i18n/zh");
const { ja } = await import("@/lib/i18n/ja");
const { ko } = await import("@/lib/i18n/ko");

const readSrc = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf-8");

const LOOP_SRC = readSrc("src/lib/agent/loop.ts");
const RUN_SRC = readSrc("src/lib/agent/use-agent-run.ts");
const TRACE_SRC = readSrc("src/components/agent-trace.tsx");

const ADDR = "0x273CE2aA3B8CCd1CaAbFfdC2710B4E10f4f360e8" as const;
const TXHASH = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;

// A realistic, minimal-yet-valid call per tool — the shape a competent model
// emits. If a schema change makes one of these REJECT, the registry and the
// prompt/examples drifted: fix deliberately, not silently.
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  get_balances: { chain: 11155111 },
  get_transaction_status: { chain: 11155111, txHash: TXHASH },
  check_attestation_status: { txHash: TXHASH },
  wait_for_attestation: { txHash: TXHASH, maxWaitSeconds: 60 },
  attestcoin_network_status: {},
  list_contacts: {},
  list_chains: {},
  list_recent_actions: { limit: 10 },
  transfer: { chain: 11155111, recipient: ADDR, token: "ETH", amount: "0.001" },
  batch_transfer: {
    chain: 11155111,
    transfers: [{ recipient: ADDR, token: "ETH", amount: "0.001" }],
  },
  deploy_contract: { mode: "template", template: "erc20", chain: 11155111, constructorArgs: { name: "Test", symbol: "TST", decimals: "18", initialSupply: "1000000" } },
  create_conditional_release: { beneficiary: ADDR, amount: "5", timeoutHours: 72 },
  execute_conditional_release: { contractAddress: ADDR, sourceTxHash: TXHASH },
  cross_chain_swap: { lockAmount: "0.0005", rateTctcPerEth: 1000 },
  create_automation_rule: {
    name: "Low ETH alert",
    triggerType: "balance_below",
    triggerConfig: { chainId: 11155111, token: "ETH", threshold: "0.01" },
    action: { kind: "notify", message: "ETH balance is low" },
  },
  update_automation_rule: { ruleId: "rule_1", active: true },
  delete_automation_rule: { ruleId: "rule_1" },
  list_automation_rules: {},
  get_app_status: {},
  create_recurring_payment: { recipient: ADDR, token: "tCTC", amount: "1", chain: 102031, cadence: "daily" },
  create_contact: { label: "Alice Chen", address: ADDR },
  list_recurring_payments: {},
  cancel_recurring_payment: { scheduleId: "sched_1" },
  decode_source_transaction: { txHash: TXHASH },
  verify_proof_readonly: { txHash: TXHASH },
  estimate_verification_cost: { txHash: TXHASH },
  get_attestation_bounds: { txHash: TXHASH },
  submit_proof_onchain: { txHash: TXHASH },
};

describe("tool coverage suite (P26)", () => {
  test("every registry tool parses its realistic sample through zod", () => {
    for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
      const sample = SAMPLE_ARGS[name];
      assert.ok(sample !== undefined, `no sample args authored for tool "${name}" — add one to SAMPLE_ARGS`);
      const parsed = def.zod.safeParse(sample);
      assert.ok(
        parsed.success,
        `tool "${name}" rejects its realistic call: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
      );
    }
  });

  test("SAMPLE_ARGS covers exactly the registry (no orphan samples)", () => {
    const registryNames = new Set(Object.keys(TOOL_REGISTRY));
    for (const name of Object.keys(SAMPLE_ARGS)) {
      assert.ok(registryNames.has(name), `sample for unknown tool "${name}" — registry and test drifted`);
    }
    assert.equal(Object.keys(SAMPLE_ARGS).length, registryNames.size, "every registry tool must have a sample");
  });

  test("registry entries are structurally valid", () => {
    for (const [key, def] of Object.entries(TOOL_REGISTRY)) {
      assert.equal(def.name, key, `registry key "${key}" must equal def.name "${def.name}"`);
      assert.ok(def.description && def.description.length > 20, `"${key}" needs a real description`);
      assert.ok(def.executor === "server" || def.executor === "client", `"${key}" executor kind invalid`);
      assert.ok(["read", "funds", "deploy", "config", "privilege"].includes(def.risk), `"${key}" risk class invalid`);
      const params = def.parameters as { type?: string; properties?: unknown };
      assert.equal(params.type, "object", `"${key}" parameters must be an object schema`);
      assert.ok(params.properties && typeof params.properties === "object", `"${key}" parameters.properties missing`);
    }
  });

  test("every tool has a dispatch case (server loop or client executor)", () => {
    for (const [name, def] of Object.entries(TOOL_REGISTRY)) {
      if (def.executor === "server") {
        assert.ok(
          LOOP_SRC.includes(`case "${name}"`),
          `server tool "${name}" has no case in loop.ts's dispatch switch — it would fall through`,
        );
      } else {
        assert.ok(
          RUN_SRC.includes(`case "${name}"`),
          `client tool "${name}" has no case in use-agent-run.ts's dispatch switch — the run would report no_executor`,
        );
      }
    }
  });

  test("every tool has a trace label key that exists in all four locales", () => {
    // Extract the TOOL_LABEL_KEYS map literal from the component source.
    const mapMatch = TRACE_SRC.match(/const TOOL_LABEL_KEYS[^{]*\{([\s\S]*?)\n\};/);
    assert.ok(mapMatch, "TOOL_LABEL_KEYS map not found in agent-trace.tsx");
    const entries = new Map<string, string>();
    for (const m of mapMatch[1].matchAll(/^\s*([a-z_]+):\s*"([^"]+)"/gm)) {
      entries.set(m[1], m[2]);
    }
    assert.ok(entries.size >= Object.keys(TOOL_REGISTRY).length, "TOOL_LABEL_KEYS looks under-populated (regex drift?)");

    const dicts: Array<[string, Record<string, string>]> = [
      ["en", en],
      ["zh", zh],
      ["ja", ja],
      ["ko", ko],
    ];

    for (const name of Object.keys(TOOL_REGISTRY)) {
      const labelKey = entries.get(name);
      assert.ok(labelKey !== undefined, `tool "${name}" has no TOOL_LABEL_KEYS entry — the trace shows a raw tool id`);
      for (const [locale, dict] of dicts) {
        assert.ok(
          labelKey in dict,
          `label key "${labelKey}" (tool "${name}") missing from the ${locale} dictionary`,
        );
      }
    }
  });
});
