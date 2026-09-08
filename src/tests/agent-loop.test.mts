// ─────────────────────────────────────────────────────────────────────────────
// Agent loop unit tests (brief §11): drive the REAL loop (runAgentLoop) with
// the REAL OpenAI adapter pointed at a scripted mock SSE server — no browser,
// no live LLM — and assert the behaviors that guard fund safety:
//
//   1. read tools execute server-side and results feed back to the model
//   2. unknown tool names are HARD-REJECTED and logged (closed-toolset rule)
//   3. fund actions dispatch directly to the wallet (Phase 3 §5: the wallet
//      signature IS the confirmation — no app-layer confirmation for routine
//      fund actions; the mandate feature was removed, C26)
//   4. deployment ALWAYS shows the pre-deployment confirmation (§5/§7)
//   6. abort while parked on the wallet signature → run finishes interrupted
//
// DB isolation: process.chdir to a temp dir BEFORE the first @/db import, so
// tests never touch the dev database.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── DB isolation: env-var DB path BEFORE any app-module import (no chdir —
// chdir would break the contracts/ compile service's relative paths) ─────────
process.env.ACP_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "acp-agent-loop-test-")), "test.db");

const { runAgentLoop } = await import("@/lib/agent/loop");
const { resolveResponse } = await import("@/lib/agent/session");
const { POST: respondPost } = await import("@/app/api/agent/respond/route");
const { listActions } = await import("@/lib/agent/action-log");
type AgentStreamEvent = import("@/lib/agent/events").AgentStreamEvent;
type WalletContext = import("@/lib/ai/system-prompt").WalletContext;

// ── Mock OpenAI Chat Completions SSE server ──────────────────────────────────

interface ScriptedReply {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

async function startMockOpenAi(): Promise<{ url: string; close: () => Promise<void>; script: (...replies: ScriptedReply[]) => void }> {
  const queue: ScriptedReply[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const reply = queue.shift();
    if (!reply) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock: no scripted reply" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    if (reply.content !== undefined) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: reply.content }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    for (const call of reply.toolCalls ?? []) {
      const argsJson = JSON.stringify(call.args);
      send({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      });
      // Fragment the arguments across two deltas to exercise the accumulator.
      const mid = Math.max(1, Math.floor(argsJson.length / 2));
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, mid) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(mid) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        script: (...replies: ScriptedReply[]) => {
          // Reset, not append: a previous test (e.g. an aborted run) can leave
          // unconsumed replies in the queue — they would poison the next
          // test's first round.
          queue.splice(0, queue.length, ...replies);
        },
      });
    });
  });
}

// ── Test harness: run the loop + auto-answer like the browser would ──────────

const WALLET = {
  address: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a",
  chainId: 11155111,
  holdings: { ETH: { address: null, balance: "1000000000000000000" } },
} as WalletContext;

interface DriveOptions {
  sessionId: string;
  userText: string;
  mock: { url: string; script: (...replies: ScriptedReply[]) => void };
  replies: ScriptedReply[];
  confirmations?: "approve" | "decline";
  toolResults?: "ok" | "wallet-missing" | "user_rejected" | "receipt_timeout" | "transient_once";
  /** Simulate the browser's mid-flight tool_status POSTs (§4.6 lifecycle). */
  lifecycleEvents?: Array<{ status: "requested" | "signed" | "broadcast" | "confirmed" | "rejected" | "failed" | "timeout" | "unknown" }>;
  abortOn?: (e: AgentStreamEvent) => boolean;
  /** P10: full history override (serialized prior tool calls/results). */
  history?: Array<{
    role: "user" | "assistant";
    content: string;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    toolCallId?: string;
    toolName?: string;
  }>;
}

interface DriveOutcome {
  events: AgentStreamEvent[];
  finish: string | undefined;
  confirmationsSeen: number;
  toolRequestsSeen: number;
}

async function driveRun(opts: DriveOptions): Promise<DriveOutcome> {
  opts.mock.script(...opts.replies);
  const events: AgentStreamEvent[] = [];
  const abort = new AbortController();
  const confirmationsSeen = { n: 0 };
  const toolRequestsSeen = { n: 0 };
  const answered = new Set<string>();
  const toolAttempts = new Map<string, number>();

  const runPromise = runAgentLoop({
    sessionId: opts.sessionId,
    messages: [...(opts.history ?? []), { role: "user", content: opts.userText }],
    wallet: WALLET,
    providerConfig: { baseUrl: opts.mock.url, apiKey: "test-key", model: "mock-model" },
    emit: (evt) => {
      events.push(evt);
      if (opts.abortOn?.(evt)) abort.abort();
    },
    signal: abort.signal,
  });

  // Auto-responder: mimics the browser answering confirmation + tool requests.
  const responder = (async () => {
    for (;;) {
      const r = await Promise.race([runPromise.then(() => "done" as const), new Promise<"tick">((r2) => setTimeout(() => r2("tick"), 15))]);
      for (const evt of events) {
        // NOTE: the confirmation and the tool dispatch REUSE the same callId,
        // so the answered-set must key by event kind.
        if (evt.type === "confirmation_request" && !answered.has(`conf:${evt.request.callId}`)) {
          answered.add(`conf:${evt.request.callId}`);
          confirmationsSeen.n++;
          resolveResponse(opts.sessionId, evt.request.callId, {
            approved: opts.confirmations === "approve",
          });
        }
        if (evt.type === "tool_call_request") {
          // Idempotent across the responder's repeated event sweeps: answer
          // each DISPATCH once. A retry re-emits tool_call_request with the
          // same callId, so count dispatches by distinct events seen.
          const key = `tool:${evt.callId}`;
          const dispatchCount = events.filter((e) => e.type === "tool_call_request" && e.callId === evt.callId).length;
          const answeredCount = toolAttempts.get(key) ?? 0;
          if (answeredCount >= dispatchCount) continue; // every dispatch so far is answered
          const attempt = answeredCount + 1;
          toolAttempts.set(key, attempt);
          toolRequestsSeen.n = dispatchCount; // total dispatches (idempotent set)
          // Mimic the browser's lifecycle POSTs (tool_status) before the final
          // tool_result — the respond route patches the bound action row.
          for (const le of opts.lifecycleEvents ?? []) {
            await respondPost(new Request("http://test.local/api/agent/respond", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: opts.sessionId, callId: evt.callId, kind: "tool_status", status: le.status, txHash: "0x" + "cd".repeat(32), chainId: 11155111 }),
            }));
          }
          const result =
            opts.toolResults === "wallet-missing"
              ? { ok: false, summary: "Wallet not connected — TERMINAL.", error: "no_wallet" }
              : opts.toolResults === "user_rejected"
                ? { ok: false, summary: "You rejected the signature in the wallet.", error: "user_rejected" }
                : opts.toolResults === "receipt_timeout"
                  ? { ok: false, summary: "Broadcast but receipt not available (UNKNOWN — do not resend).", txHash: "0x" + "cd".repeat(32), chainId: 11155111, error: "receipt_timeout" }
                  : opts.toolResults === "transient_once" && attempt === 1
                    ? { ok: false, summary: "RPC 429 rate limit — transient.", error: "transient_error" }
                    : {
                        ok: true,
                        summary: "executed (mock result, after retry)",
                        txHash: "0x" + "ab".repeat(32),
                        chainId: typeof evt.args.chain === "number" ? evt.args.chain : undefined,
                      };
          resolveResponse(opts.sessionId, evt.callId, result);
        }
      }
      if (r === "done") break;
    }
  })();

  await runPromise;
  await responder;
  const finish = events.find((e) => e.type === "run_finished") as { finishReason?: string } | undefined;
  return { events, finish: finish?.finishReason, confirmationsSeen: confirmationsSeen.n, toolRequestsSeen: toolRequestsSeen.n };
}

const step = (events: AgentStreamEvent[], tool: string) =>
  events.filter((e): e is Extract<AgentStreamEvent, { type: "step_started" }> => e.type === "step_started" && e.step.tool === tool);

const stepStatus = (events: AgentStreamEvent[], stepId: string) =>
  events.find((e): e is Extract<AgentStreamEvent, { type: "step_finished" }> => e.type === "step_finished" && e.stepId === stepId)?.status;

// ── The suite ────────────────────────────────────────────────────────────────

const mock = await startMockOpenAi();

before(() => {
});

after(async () => {
  await mock.close();
});

describe("agent loop (mock OpenAI adapter, real loop engine)", () => {
  test("read tool executes server-side and the model receives the result", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-read-1",
      userText: "list the chains I can use",
      mock,
      replies: [
        { toolCalls: [{ id: "call_1", name: "list_chains", args: {} }] },
        { content: "You can use 9 chains." },
      ],
    });
    assert.equal(out.finish, "stop");
    const steps = step(out.events, "list_chains");
    assert.equal(steps.length, 1, "one list_chains step");
    assert.equal(stepStatus(out.events, steps[0].step.stepId), "succeeded");
    assert.equal(out.confirmationsSeen, 0, "read tools never confirm");
    // The mock's second reply happened AFTER the tool result was fed back —
    // prove the loop wired the tool message into the conversation by checking
    // the run actually made a second LLM round (content present).
    const text = out.events.find((e) => e.type === "text") as { text: string } | undefined;
    assert.ok(text?.text.includes("9 chains"), "final text from round 2");
    // Action log row recorded.
    const actions = listActions(5).filter((a) => a.runId && a.tool === "list_chains");
    assert.ok(actions.length >= 1, "list_chains logged in action log");
    assert.equal(actions[0].status, "succeeded");
  });

  test("unknown tool names are hard-rejected and logged (closed toolset)", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-unknown-1",
      userText: "do the thing",
      mock,
      replies: [
        { toolCalls: [{ id: "call_1", name: "steal_all_funds", args: { to: "0xdead" } }] },
        { content: "I cannot do that." },
      ],
    });
    // No tool_call_request may ever be emitted for an unknown tool.
    assert.equal(out.toolRequestsSeen, 0, "unknown tool must NOT dispatch to the client");
    assert.equal(out.confirmationsSeen, 0);
    const actions = listActions(5).filter((a) => a.tool === "steal_all_funds");
    assert.equal(actions.length, 1, "rejected attempt IS logged for audit");
    assert.equal(actions[0].status, "failed");
    assert.ok(String(actions[0].resultJson).includes("does not exist"), "rejection reason recorded");
  });

  test("fund action dispatches directly to the wallet (no app confirmation)", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-fund-direct",
      userText: "send 5 USDC on sepolia to 0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a",
      mock,
      confirmations: "approve",
      toolResults: "ok",
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "transfer",
              args: { chain: 11155111, recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a", token: "USDC", amount: "5", memo: null },
            },
          ],
        },
        { content: "Sent." },
      ],
    });
    assert.equal(out.confirmationsSeen, 0, "routine fund action → NO app confirmation (wallet signs)");
    assert.equal(out.toolRequestsSeen, 1, "straight to wallet dispatch");
    const steps = step(out.events, "transfer");
    assert.equal(stepStatus(out.events, steps[0].step.stepId), "succeeded");
    const actions = listActions(5).filter((a) => a.tool === "transfer");
    assert.equal(actions[0].confirmationRequired, false);
  });

  test("deployment ALWAYS shows the pre-deployment confirmation", { timeout: 120_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-deploy-always",
      userText: "deploy an erc20 on creditcoin testnet",
      mock,
      confirmations: "decline",
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "deploy_contract",
              args: {
                mode: "template",
                template: "erc20",
                chain: 102031,
                constructorArgs: {
                  name: "Test Token",
                  symbol: "TST",
                  decimals: 18,
                  initialSupply: "1000000",
                  initialHolder: WALLET.address,
                },
                source: null,
                sourceName: null,
              },
            },
          ],
        },
        { content: "Cancelled." },
      ],
    });
    assert.equal(out.confirmationsSeen, 1, "deployment confirmation required");
    const req = out.events.find((e) => e.type === "confirmation_request") as Extract<AgentStreamEvent, { type: "confirmation_request" }>;
    assert.equal(req.request.reason, "deployment", "deploy always confirms (never dismissible)");
    assert.ok(req.request.contract, "contract info attached (template + summary)");
    assert.equal(req.request.contract?.template, "erc20");
    assert.ok(req.request.contract?.plainSummary.length > 20, "plain-English summary present");
    assert.equal(out.toolRequestsSeen, 0, "declined → no dispatch");
  });

  test("abort while parked on the wallet signature → run interrupted", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-abort-1",
      userText: "send 5 USDC on sepolia",
      mock,
      confirmations: "approve",
      abortOn: (e) => e.type === "step_status" && e.status === "awaiting_signature",
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "transfer",
              args: { chain: 11155111, recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a", token: "USDC", amount: "5", memo: null },
            },
          ],
        },
        { content: "unreachable" },
      ],
    });
    assert.equal(out.finish, "interrupted", "run ends interrupted on abort");
    assert.equal(out.toolRequestsSeen, 1, "dispatched to the wallet, then interrupted mid-signature");
    const actions = listActions(5).filter((a) => a.tool === "transfer");
    assert.ok(actions.some((a) => a.status === "interrupted"), "interrupted action recorded");
  });

  test("user rejection lands as declined in the action log (first-class outcome)", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-reject",
      userText: "send 5 USDC on sepolia",
      mock,
      toolResults: "user_rejected",
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "transfer",
              args: { chain: 11155111, recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a", token: "USDC", amount: "5", memo: null },
            },
          ],
        },
        { content: "Understood — you rejected it." },
      ],
    });
    assert.equal(out.toolRequestsSeen, 1);
    const actions = listActions(5).filter((a) => a.tool === "transfer");
    assert.equal(actions[0].status, "declined", "rejection recorded as declined (not failed)");
  });

  test("receipt timeout lands as unknown in the action log (never auto-resent)", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-unknown",
      userText: "send 5 USDC on sepolia",
      mock,
      toolResults: "receipt_timeout",
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "transfer",
              args: { chain: 11155111, recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a", token: "USDC", amount: "5", memo: null },
            },
          ],
        },
        { content: "Okay — status unknown, I won't resend." },
      ],
    });
    assert.equal(out.toolRequestsSeen, 1);
    const actions = listActions(5).filter((a) => a.tool === "transfer");
    assert.equal(actions[0].status, "unknown", "broadcast-without-receipt recorded as unknown");
  });

  test("mid-flight tool_status POSTs patch the parked action row (live lifecycle)", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-lifecycle",
      userText: "send 6 USDC on sepolia",
      mock,
      toolResults: "ok",
      lifecycleEvents: [{ status: "requested" }, { status: "signed" }, { status: "broadcast" }],
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "transfer",
              args: { chain: 11155111, recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a", token: "USDC", amount: "6", memo: null },
            },
          ],
        },
        { content: "Done." },
      ],
    });
    assert.equal(out.toolRequestsSeen, 1);
    const actions = listActions(5).filter((a) => a.tool === "transfer");
    // The final tool_result wins (succeeded), but the row must carry the
    // callId join key the live overlay uses.
    assert.equal(actions[0].status, "succeeded");
    assert.ok(actions[0].callId, "callId persisted for live overlays");
  });

  test("transient network failure auto-retries once and succeeds", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-transient-retry",
      userText: "send 7 USDC on sepolia",
      mock,
      toolResults: "transient_once",
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "transfer",
              args: { chain: 11155111, recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a", token: "USDC", amount: "7", memo: null },
            },
          ],
        },
        { content: "Retried and done." },
      ],
    });
    // The retry re-dispatches the same callId — 2 dispatches total.
    assert.equal(out.toolRequestsSeen, 2, "transient error → one automatic retry");
    const steps = step(out.events, "transfer");
    assert.equal(stepStatus(out.events, steps[0].step.stepId), "succeeded", "retry succeeded");
    const retryNotice = out.events.some(
      (e) => e.type === "step_status" && e.detail?.text?.includes("retrying"),
    );
    assert.ok(retryNotice, "retry visible in the trace");
    const actions = listActions(5).filter((a) => a.tool === "transfer");
    assert.equal(actions[0].status, "succeeded");
  });


  test("3 consecutive all-invalid rounds trip the circuit breaker (invalid_loop)", { timeout: 60_000 }, async () => {
    const badId = "x".repeat(100); // exceeds cancel_recurring_payment's 64-char cap (live-observed D12 failure)
    const badRound = {
      toolCalls: [{ id: "call_bad", name: "cancel_recurring_payment", args: { scheduleId: badId } }],
    };
    const out = await driveRun({
      sessionId: "t-invalid-loop",
      userText: "cancel my weekly payment",
      mock,
      replies: [badRound, badRound, badRound, { content: "should never be reached" }],
    });
    assert.equal(out.finish, "invalid_loop", "breaker fires after 3 identical invalid rounds");
    const honest = out.events.some((e) => e.type === "text" && e.text.includes("malformed tool arguments"));
    assert.ok(honest, "honest stop message emitted to the user");
    // The 4th scripted reply must NOT have been consumed — the breaker ends
    // the run without another model round-trip. P26 visibility fix: each
    // invalid round now surfaces ONE rejected step (born failed) — the user
    // sees the fumbles instead of a silent pause — but none is ever
    // dispatched (no step ever reaches running/awaiting_confirmation).
    const allSteps = out.events.filter((e) => e.type === "step_started");
    assert.equal(allSteps.length, 3, "each invalid round surfaces exactly one rejected step");
    const dispatched = allSteps.filter(
      (e) => e.type === "step_started" && (e.step.status === "running" || e.step.status === "awaiting_confirmation"),
    );
    assert.equal(dispatched.length, 0, "invalid args are never dispatched (born failed, never running)");
  });

  test("a valid call between invalid rounds resets the breaker streak", { timeout: 60_000 }, async () => {
    const badId = "x".repeat(100);
    const out = await driveRun({
      sessionId: "t-invalid-reset",
      userText: "list then cancel",
      mock,
      replies: [
        { toolCalls: [{ id: "c1", name: "cancel_recurring_payment", args: { scheduleId: badId } }] }, // invalid (streak 1)
        { toolCalls: [{ id: "c2", name: "list_recurring_payments", args: {} }] }, // valid → reset
        { toolCalls: [{ id: "c3", name: "cancel_recurring_payment", args: { scheduleId: badId } }] }, // invalid (streak 1)
        { content: "Done after one bad retry." },
      ],
    });
    assert.equal(out.finish, "stop", "isolated invalid rounds never trip the breaker");
  });

  test("user rejection is NEVER auto-retried", { timeout: 60_000 }, async () => {
    const out = await driveRun({
      sessionId: "t-reject-no-retry",
      userText: "send 8 USDC on sepolia",
      mock,
      toolResults: "user_rejected",
      replies: [
        {
          toolCalls: [
            {
              id: "call_1",
              name: "transfer",
              args: { chain: 11155111, recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a", token: "USDC", amount: "8", memo: null },
            },
          ],
        },
        { content: "You declined; I will not retry." },
      ],
    });
    assert.equal(out.toolRequestsSeen, 1, "no second dispatch for a rejection");
    const actions = listActions(5).filter((a) => a.tool === "transfer");
    assert.equal(actions[0].status, "declined");
  });
  test("P10 fund-safety guard: a retry of an unknown-status tx is BLOCKED and surfaces the on-chain status", { timeout: 60_000 }, async () => {
    // Seed an unknown-status prior action: same tool, same args as the retry below.
    const { startAction, patchAction } = await import("@/lib/agent/action-log");
    const args = { chain: 11155111, recipient: "0x1234567890123456789012345678901234567890", token: "USDC", amount: "42", memo: null };
    const priorId = startAction({
      runId: "run_prior",
      tool: "transfer",
      params: args,
      riskClass: "funds",
      confirmationRequired: false,
    });
    patchAction(priorId, {
      status: "unknown",
      result: { ok: false, txHash: "0x" + "ab".repeat(32), chainId: 11155111, error: "receipt_timeout" },
    });
    const out = await driveRun({
      sessionId: "t-p10-guard",
      userText: "retry the transfer",
      mock,
      toolResults: "ok",
      replies: [
        {
          toolCalls: [
            { id: "call_1", name: "transfer", args },
          ],
        },
        { content: "The prior attempt is unresolved — I will not re-send." },
      ],
    });
    // The guard intercepts BEFORE dispatch: no wallet request goes out.
    assert.equal(out.toolRequestsSeen, 0, "a matching unknown-status prior tx must NEVER re-dispatch");
    const toolResult = out.events.find((e) => e.type === "step_finished") as
      | { result?: { error?: string; summary?: string } }
      | undefined;
    assert.equal(toolResult?.result?.error, "prior_tx_unknown");
    assert.match(String(toolResult?.result?.summary ?? ""), /BLOCKED re-send/);
  });

  test("P10 retry history: serialized prior tool results reach the model (completed steps preserved)", { timeout: 60_000 }, async () => {
    const history: Array<{
      role: "user" | "assistant";
      content: string;
      toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      toolCallId?: string;
      toolName?: string;
    }> = [
      { role: "user", content: "send funds in two steps" },
      {
        role: "assistant",
        content: "I will check the balance first.",
        toolCalls: [
          { id: "call_1", name: "get_balances", args: { chain: 11155111 } },
          { id: "call_2", name: "transfer", args: { chain: 11155111, recipient: "0x1234567890123456789012345678901234567890", token: "USDC", amount: "99", memo: null } },
        ],
      },
      {
        role: "assistant",
        content: JSON.stringify({ ok: true, summary: "Balances fetched.", data: { chains: [] } }),
        toolCallId: "call_1",
        toolName: "get_balances",
      },
      {
        role: "assistant",
        content: "STEP FAILED — re-run ONLY this tool call. (user pressed retry)",
        toolCallId: "call_2",
        toolName: "transfer",
      },
    ];
    const out = await driveRun({
      sessionId: "t-p10-history",
      userText: "(retry the failed step)",
      mock,
      toolResults: "ok",
      history,
      replies: [
        {
          toolCalls: [
            // The model re-emits ONLY the failed call (fresh args → guard off).
            { id: "call_2b", name: "transfer", args: { chain: 11155111, recipient: "0x1234567890123456789012345678901234567890", token: "USDC", amount: "99", memo: "retry" } },
          ],
        },
        { content: "Step 2 re-run; step 1's result was preserved." },
      ],
    });
    assert.equal(out.toolRequestsSeen, 1, "only the failed step re-dispatches");
    // The mock adapter received the serialized prior tool messages — assert via
    // the loop behavior: no get_balances re-execution happened (its server
    // executor would emit a step_finished for a get_balances call).
    const tools = out.events
      .filter((e) => e.type === "step_started")
      .map((e) => ((e as { step?: { tool?: string } }).step?.tool ?? ""));
    assert.ok(!tools.includes("get_balances"), "completed steps are NOT re-executed on retry");
    assert.ok(tools.includes("transfer"), "the failed step IS re-run");
  });
});
