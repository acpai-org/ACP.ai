import { db, ensureDb } from "@/db";
import { skills } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getChainByChainId } from "@/lib/chains/registry";
import { TOOL_REGISTRY, TOOL_NAMES, isKnownTool, type ToolDef } from "@/lib/agent/tool-registry";
import { startAction, patchAction } from "@/lib/agent/action-log";
import { awaitResponse, bindRun, bindCallAction, newRunId } from "@/lib/agent/session";
import type { AgentStreamEvent, ConfirmationRequest, TraceStep, TraceStepStatus } from "@/lib/agent/events";
import { buildAgentSystemPrompt } from "@/lib/agent/system-prompt";
import type { WalletContext } from "@/lib/ai/system-prompt";
import { createOpenAiAdapter } from "@/lib/agent/llm/openai";
import type { LlmAdapter, LlmMessage, ToolCallRequest, ToolSpec } from "@/lib/agent/llm/types";
import { LlmError } from "@/lib/agent/llm/types";
import { prepareDeployment } from "@/lib/contracts/prepare";
import { prepareClientTool } from "@/lib/agent/prepare-client";
import {
  buildTransferFeeEstimate,
  deployFeeEstimate,
  releaseFeeEstimate,
  sumFeeBreakdown,
  type FeeEstimate,
} from "@/lib/agent/fee-estimate";

// ─────────────────────────────────────────────────────────────────────────────
// The agent loop (brief §2): a tool-calling loop, not single-shot chat.
//
//   model → tool calls → app executes them (server tools directly; wallet
//   tools dispatched to the browser over the NDJSON channel) → results feed
//   back to the model → repeat until the task resolves or needs the user.
//
// Everything the user needs to see rides the same stream: live trace steps,
// confirmation prompts, text. Hard boundaries enforced HERE:
//   - only tools from TOOL_REGISTRY can execute (unknown names are rejected
//     and logged, never interpreted);
//   - contract deployment always shows the pre-deployment confirmation
//     (source/template + plain-English summary) before anything goes on-chain;
//   - routine fund actions are confirmed by the WALLET SIGNATURE itself
//     (Phase 3 §5 — the app adds no extra confirmation layer); the trace
//     shows the concrete details before and during the signature;
//   - every action lands in the persistent action log with its proof refs.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  sessionId: string;
  /** Conversation history INCLUDING the new user message as the last entry.
   *  P10: assistant entries may carry the tool calls the model previously
   *  emitted, and tool results may ride as assistant entries with
   *  toolCallId/toolName set — the loop maps those to the LLM's tool role so
   *  a retry sees the COMPLETED steps' results (and re-runs only the failed
   *  step instead of the whole turn). */
  messages: AgentHistoryMessage[];
  wallet: WalletContext | null;
  providerConfig: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number | null;
  };
  emit: (evt: AgentStreamEvent) => void;
  signal: AbortSignal;
}

/** P10: history entries can carry prior tool calls/results (see AgentRunOptions). */
export interface AgentHistoryMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolCallId?: string;
  toolName?: string;
}

const MAX_ROUNDS = 8;
const TOOL_RESULT_TIMEOUT_MS = 10 * 60_000;
const CONFIRMATION_TIMEOUT_MS = 5 * 60_000;

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortAddr(a: string | undefined): string {
  return a ? `${a.slice(0, 8)}…${a.slice(-4)}` : "?";
}

/** Build the human summary shown on the confirmation card. */
function confirmationSummary(tool: string, args: Record<string, unknown>): string {
  const chain = getChainByChainId(typeof args.chain === "number" ? args.chain : -1);
  const chainName = chain?.name ?? "unknown chain";
  switch (tool) {
    case "transfer":
      return `Send ${String(args.amount)} ${String(args.token)} on ${chainName} to ${shortAddr(String(args.recipient))}${typeof args.memo === "string" && args.memo ? ` — "${args.memo}"` : ""}`;
    case "batch_transfer": {
      const list = Array.isArray(args.transfers) ? args.transfers : [];
      return `${list.length} transfers on ${chainName} (total ~${list.length} signatures)`;
    }
    case "deploy_contract":
      return args.mode === "template"
        ? `Deploy the ${String(args.template)} template contract on ${chainName}`
        : `Deploy your custom contract "${String(args.sourceName ?? "unnamed")}" on ${chainName}`;
    case "create_conditional_release":
      return `Deploy + escrow: lock ${String(args.amount ?? "?")} tCTC in a ConditionalRelease contract on Creditcoin Testnet for ${shortAddr(String(args.beneficiary ?? ""))} (the contract + escrow deploy in ONE payable transaction)`;
    case "cross_chain_swap":
      return `Cross-chain swap on Sepolia → Creditcoin: lock ${String(args.lockAmount ?? "?")} ETH at ${String(args.rateTctcPerEth ?? "?")} tCTC/ETH — deploys BOTH swap contracts (3 signatures now, 1 later) and pre-funds the tCTC release side`;
    case "create_automation_rule":
      return `Create the automation rule "${String(args.name ?? "?")}" (when its trigger fires, it ${String((args.action as { kind?: string } | undefined)?.kind) === "transfer" ? "will ask the wallet to sign a transfer" : "will send a notification"})`;
    case "delete_automation_rule":
      return `PERMANENTLY delete the automation rule ${String(args.ruleId ?? "?").slice(0, 12)}… — find it first with list_automation_rules if unsure`;
    case "create_automation_rule":
      return `Create the automation rule "${String(args.name ?? "?")}" (when its trigger fires, it ${String((args.action as { kind?: string } | undefined)?.kind) === "transfer" ? "will ask the wallet to sign a transfer" : "will send a notification"})`;
    case "delete_automation_rule":
      return `PERMANENTLY delete the automation rule ${String(args.ruleId ?? "?").slice(0, 12)}… — find it first with list_automation_rules if unsure`;
    case "submit_proof_onchain":
      return `Submit the Attestcoin proof for ${String(args.txHash ?? "").slice(0, 14)}… for on-chain verification on Creditcoin (spends the app submission account's gas; emits TransactionVerified)`;
    default:
      return `Execute ${tool}`;
  }
}

function confirmationReasonText(reason: ConfirmationRequest["reason"]): string {
  switch (reason) {
    case "deployment":
      return "Contract deployment always requires explicit confirmation";
    default:
      return "Confirmation required";
  }
}

/**
 * Gas-units estimate for the pre-signature fee row (brief §5). The
 * deterministic half lives here (tool + validated args); the client supplies
 * the live gas price. Tools with no on-chain component (recurring rule
 * creation, read tools) return null — no fee row.
 */
function confirmationFeeEstimate(
  tool: string,
  args: Record<string, unknown>,
  contractInfo: ConfirmationRequest["contract"] | undefined,
  preparedBreakdown: Array<{ label: string; gasUnits: string }> | undefined,
): FeeEstimate | null {
  switch (tool) {
    case "transfer":
    case "batch_transfer":
      // P5: the LIVE-estimated breakdown from the preparation layer wins
      // (eth_estimateGas against the exact tx shape). Fallback: the native
      // transfer's protocol-exact 21000 — a fact, not an estimate.
      if (preparedBreakdown && preparedBreakdown.length > 0) return sumFeeBreakdown(preparedBreakdown);
      return buildTransferFeeEstimate(args);
    case "deploy_contract":
    case "create_conditional_release":
      // Deployment-shaped: solc's creation estimate rides on contractInfo.
      return deployFeeEstimate(contractInfo?.estimatedGas);
    case "execute_conditional_release":
      // Live-estimated with the real proof calldata at prep; the nominal
      // constant is a LAST resort (estimation unavailable).
      if (preparedBreakdown && preparedBreakdown.length > 0) return sumFeeBreakdown(preparedBreakdown);
      return releaseFeeEstimate();
    case "cross_chain_swap":
      return preparedBreakdown && preparedBreakdown.length > 0 ? sumFeeBreakdown(preparedBreakdown) : null;
    default:
      return null;
  }
}

interface ToolOutcome {
  ok: boolean;
  summary: string;
  txHash?: string;
  chainId?: number;
  data?: Record<string, unknown>;
  error?: string;
}

export async function runAgentLoop(opts: AgentRunOptions): Promise<void> {
  const { sessionId, wallet, providerConfig, emit, signal } = opts;
  const runId = newRunId();
  bindRun(sessionId, runId);
  emit({ type: "run_started", runId, sessionId });

  // ── Provider: BYOK OpenAI-compatible Chat Completions (C27: the built-in
  //    provider was removed — only the user-configured custom provider runs
  //    the loop). Keys are passed per request and never persisted server-side.
  if (!providerConfig.apiKey) {
    emit({ type: "error", error: "AI provider not configured. Set your API key in Chat Settings.", code: "provider_not_configured" });
    emit({ type: "run_finished", finishReason: "error", steps: [] });
    return;
  }
  // N1: no silent default model — an empty model fails clearly instead of
  // quietly running something the user never chose.
  if (!providerConfig.model?.trim()) {
    emit({ type: "error", error: "No model set. Pick one in the model picker (or Settings → AI Provider) — format: provider/modelname.", code: "model_not_set" });
    emit({ type: "run_finished", finishReason: "error", steps: [] });
    return;
  }
  const adapter: LlmAdapter = createOpenAiAdapter({
    baseUrl: providerConfig.baseUrl || "https://api.openai.com/v1",
    apiKey: providerConfig.apiKey,
    model: providerConfig.model.trim(),
    temperature: providerConfig.temperature,
    topP: providerConfig.topP,
    maxTokens: providerConfig.maxTokens ?? null,
  });

  // ── System prompt + tool set (skills can narrow the toolset) ──────────────
  const system = buildAgentSystemPrompt(wallet);
  const allowlist = activeSkillToolAllowlist();
  // FLAT specs ({name, description, parameters}) — the adapter layer wraps
  // them per provider (OpenAI nests under function{}). Do NOT pass
  // openaiToolSpecs() here.
  const tools: ToolSpec[] = TOOL_NAMES.filter((name) => !allowlist || allowlist.has(name)).map((name) => ({
    name,
    description: TOOL_REGISTRY[name].description,
    parameters: TOOL_REGISTRY[name].parameters,
  }));

  const llmMessages: LlmMessage[] = opts.messages.map((m) => {
    if (m.toolCallId && m.toolName) {
      // P10: serialized prior tool RESULT — the LLM's tool role.
      return { role: "tool", toolCallId: m.toolCallId, toolName: m.toolName, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // P10: serialized prior assistant tool CALLS.
      return {
        role: "assistant",
        content: m.content,
        toolCalls: m.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          argsJson: JSON.stringify(c.args ?? {}),
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
  const steps: TraceStep[] = [];
  let finishReason: "stop" | "error" | "interrupted" | "max_rounds" | "invalid_loop" = "stop";
  // Circuit breaker (C38/D12): a model that keeps re-sending invalid tool
  // arguments round after round would otherwise burn the full round budget
  // on garbage (observed 7 identical rejections in live QA). 3 consecutive
  // all-invalid rounds → honest stop instead of a token bonfire.
  let consecutiveInvalidRounds = 0;

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");

      const resp = await adapter.chat({
        system,
        messages: llmMessages,
        tools,
        signal,
        onTextDelta: (text) => emit({ type: "text", text }),
        onReasoningDelta: (text) => emit({ type: "reasoning", text }),
      });
      if (resp.content) emit({ type: "text_done" });

      if (resp.toolCalls.length === 0) {
        break; // final answer (or clarification) — loop ends
      }
      if (round === MAX_ROUNDS) {
        finishReason = "max_rounds";
        emit({ type: "text", text: "\n\n(I've hit my step budget for this request — let's continue from here.)" });
        break;
      }

      llmMessages.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });

      // Execute tool calls sequentially — wallet actions are serial by nature.
      const outcomes = [];
      for (const call of resp.toolCalls) {
        const outcome = await executeToolCall(call, {
          runId,
          sessionId,
          wallet,
          emit,
          signal,
          steps,
          skillAllowlist: allowlist,
        });
        outcomes.push(outcome);
        llmMessages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify(outcome),
        });
      }

      // Circuit-breaker bookkeeping: a round counts as invalid only when EVERY
      // call failed schema validation — a single good call resets the streak.
      const allInvalid =
        outcomes.length > 0 &&
        outcomes.every((o) => o.error === "invalid_args" || o.error === "bad_json");
      consecutiveInvalidRounds = allInvalid ? consecutiveInvalidRounds + 1 : 0;
      if (consecutiveInvalidRounds >= 3) {
        finishReason = "invalid_loop";
        emit({
          type: "text",
          text: "\n\n(I keep sending malformed tool arguments, so I stopped rather than retry the same mistake. The details above show what each tool expects — you can ask again and I'll try a different approach.)",
        });
        break;
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      finishReason = "interrupted";
    } else if (err instanceof LlmError) {
      finishReason = "error";
      emit({ type: "error", error: err.message, code: err.code });
    } else {
      finishReason = "error";
      emit({ type: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  emit({ type: "run_finished", finishReason, steps });
}

function activeSkillToolAllowlist(): Set<string> | null {
  try {
    ensureDb();
    const active = db.select().from(skills).where(eq(skills.enabled, true)).all();
    if (active.length === 0) return null;
    const lists = active
      .map((s) => {
        try {
          const parsed = s.toolAllowlist ? (JSON.parse(s.toolAllowlist) as string[]) : null;
          return Array.isArray(parsed) ? parsed.filter((n) => isKnownTool(n)) : null;
        } catch {
          return null;
        }
      })
      .filter((l): l is string[] | null => l === null || Array.isArray(l));
    // F1 (D.6 audit): a skill with a NULL allowlist grants ALL fixed tools
    // (§12 convention) — the union with the universe is the universe. The
    // previous code dropped nulls BEFORE unioning, silently narrowing below
    // a member's grant.
    if (lists.some((l) => l === null)) return null;
    // Union of concrete allowlists: multiple skills combine, never restrict
    // below the union.
    const union = new Set<string>();
    for (const l of lists) {
      if (l) for (const n of l) union.add(n);
    }
    return union.size > 0 ? union : null;
  } catch {
    return null;
  }
}

interface ExecContext {
  runId: string;
  sessionId: string;
  wallet: WalletContext | null;
  emit: (evt: AgentStreamEvent) => void;
  signal: AbortSignal;
  steps: TraceStep[];
  /**
   * Active skills' tool allowlist (null = all tools). F2 (D.6 audit): the
   * allowlist gates EXECUTION, not just the advertised toolset — a model
   * emitting a non-advertised tool call is rejected here, same as unknown
   * tools.
   */
  skillAllowlist: Set<string> | null;
}

async function executeToolCall(call: ToolCallRequest, ctx: ExecContext): Promise<ToolOutcome> {
  const { runId, sessionId, emit, signal, steps } = ctx;
  const stepId = randomId("step");
  const callId = randomId("call");

  // ── P26 silent-rejection fix: every rejected call is a VISIBLE failed step ──
  // A call that never executes (unknown tool, allowlist block, malformed
  // JSON, schema-invalid args) used to be invisible to the user — only the
  // model received the corrective feedback (a console.log server-side was
  // the entire audit trail for two of the four paths). Now every rejection
  // lands in the action log AND surfaces in the live trace as a step born
  // failed (never dispatched, never "running") — the same treatment the P10
  // blocked-re-send guard already gives never-executed calls. The model's
  // feedback loop is unchanged.
  const rejectCall = (summary: string, error: string, riskClass: string): ToolOutcome => {
    const actionId = startAction({
      runId,
      callId,
      tool: call.name,
      params: { raw: call.argsJson.slice(0, 2000) },
      riskClass,
      confirmationRequired: false,
    });
    patchAction(actionId, { status: "failed", result: { ok: false, summary } });
    const step: TraceStep = {
      stepId,
      callId,
      tool: call.name,
      args: { raw: call.argsJson.slice(0, 2000) },
      status: "failed",
      title: call.name,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
    steps.push(step);
    emit({ type: "step_started", step });
    const outcome: ToolOutcome = { ok: false, summary, error };
    emit({ type: "step_finished", stepId, status: "failed", result: outcome });
    return outcome;
  };

  // ── Hard boundary: only registry tools execute — ever ─────────────────────
  const def: ToolDef | undefined = TOOL_REGISTRY[call.name];
  if (!def) {
    // Log + surface the rejected attempt, return a structured error to the model.
    return rejectCall(
      `Tool "${call.name}" does not exist. Only tools from the provided list are available. Re-read the tool list and use an exact name.`,
      "unknown_tool",
      "read",
    );
  }

  // ── F2 (D.6 audit): skill allowlist enforcement at EXECUTION time ──────
  // The toolset advertised to the model is already filtered by the allowlist,
  // but a hallucinated call for a non-advertised (still-registered) tool must
  // be rejected here too — enforcement can't live only in the advertisement.
  if (ctx.skillAllowlist && !ctx.skillAllowlist.has(call.name)) {
    const allowed = [...ctx.skillAllowlist].sort().join(", ");
    return rejectCall(
      `Tool "${call.name}" is not available while the current skill configuration restricts the toolset. Available tools: ${allowed}.`,
      "skill_allowlist",
      "read",
    );
  }

  // ── Validate args with the shared zod schema ───────────────────────────────
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.argsJson || "{}") as Record<string, unknown>;
  } catch {
    return rejectCall(
      "Tool arguments were not valid JSON. Re-emit the call with corrected JSON arguments.",
      "bad_json",
      def.risk,
    );
  }
  const parsed = def.zod.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    console.log(`[agent] tool ${call.name} args invalid: ${issues} | raw: ${call.argsJson.slice(0, 300)}`);
    return rejectCall(
      `Arguments rejected by validation: ${issues}. IMPORTANT: amounts must be decimal STRINGS like '0.5' (never bare numbers), addresses 0x-prefixed, chain IDs integers. Fix the arguments and call again.`,
      "invalid_args",
      def.risk,
    );
  }
  args = parsed.data as Record<string, unknown>;

  // ── P10 fund-safety guard: never blindly re-send a possibly-broadcast tx ────
  // If a PREVIOUS attempt of this exact call (same tool + same arguments) is
  // sitting in an in-flight/unknown state (broadcast, receipt never arrived),
  // a retry must NOT re-execute it — the tx may already be landing on-chain
  // (double-spend risk, hard boundary 7). Instead: check the prior tx's
  // ACTUAL on-chain state and surface that to the model.
  if (def.executor === "client" && (def.risk === "funds" || def.risk === "deploy")) {
    const { priorUnknownTxActions } = await import("@/lib/agent/action-log");
    // Compare against the PARSED args — the action log stores the zod-parsed
    // form (defaults applied), so a retry normalizes to the same shape.
    const prior = priorUnknownTxActions(def.name, JSON.stringify(args));
    if (prior.length > 0) {
      const st = await import("@/lib/agent/server-tools");
      const checks: string[] = [];
      let anyNotFoundAndStale = false;
      let anyMined = false;
      for (const row of prior.slice(0, 3)) {
        let txHash: string | undefined;
        let chainId: number | undefined;
        try {
          const r = JSON.parse(row.resultJson ?? "{}") as { txHash?: string; chainId?: number };
          txHash = r.txHash;
          chainId = r.chainId;
        } catch {
          /* malformed result — skip */
        }
        if (txHash && typeof chainId === "number") {
          const outcome = await st.execGetTransactionStatus({ chain: chainId, txHash }, { wallet: ctx.wallet });
          checks.push(
            `prior attempt (action ${row.id.slice(0, 10)}…, tx ${txHash.slice(0, 16)}…): ${outcome.summary}`,
          );
          const found = (outcome.data as { status?: string } | undefined)?.status;
          if (found === "succeeded" || found === "reverted") anyMined = true;
          // "unknown" from the status tool = NOT findable on-chain. A tx that
          // was broadcast >30 minutes ago and is still unfindable almost
          // certainly never landed (mempool drop) — a re-send is then safe.
          if (found === "unknown" && Date.now() - row.createdAt > 30 * 60_000) anyNotFoundAndStale = true;
        } else {
          checks.push(
            `prior attempt (action ${row.id.slice(0, 10)}…) is in an UNKNOWN state with no recorded tx hash — ask the user to check it in the wallet/explorer before any re-send.`,
          );
        }
      }
      // Safe-release path: every prior tx is CONFIRMED absent from the chain
      // and the row is old — the broadcast never landed, a re-send cannot
      // double-spend. Execute with the prior-attempt context surfaced.
      if (!anyMined && anyNotFoundAndStale) {
        console.log(`[agent] P10 guard: prior unknown tx(s) confirmed absent on-chain (>30m) — allowing re-send of ${def.name}`);
      } else {
        const actionId = startAction({
          runId,
          tool: def.name,
          params: args,
          riskClass: def.risk,
          confirmationRequired: false,
        });
        patchAction(actionId, {
          status: "failed",
          result: { ok: false, summary: "Retry blocked: a prior attempt of this exact action has an unresolved on-chain state." },
        });
        // Surface the block in the live trace (P24: every attempt is visible).
        const guardStep: TraceStep = {
          stepId: randomId("step"),
          callId,
          tool: def.name,
          args,
          status: "failed",
          title: def.traceTitle?.(args) ?? def.name,
          startedAt: Date.now(),
        };
        steps.push(guardStep);
        emit({ type: "step_started", step: guardStep });
        const blockedOutcome = {
          ok: false,
          summary: `BLOCKED re-send: a previous attempt of this exact ${def.name} call is in an UNRESOLVED state (broadcast, receipt never confirmed) — re-sending now risks a DOUBLE-SPEND. Live on-chain status of the prior attempt(s): ${checks.join(" | ")}. If a prior tx SUCCEEDED, the job is already done — report that to the user. If it is still not findable, wait (attestation/RPC lag) or have the user check the explorer link before deciding. Never re-issue this call with these arguments unless the user explicitly confirms after seeing the status.`,
          error: "prior_tx_unknown",
        };
        guardStep.finishedAt = Date.now();
        emit({
          type: "step_finished",
          stepId: guardStep.stepId,
          status: "failed",
          result: blockedOutcome,
        });
        return blockedOutcome;
      }
    }
  }

  // ── Risk gating (Phase 3 §5) ───────────────────────────────────────────────
  // The wallet signature IS the confirmation for routine fund actions — the
  // app adds no extra confirmation layer. Contract deployment keeps its
  // pre-deployment confirmation (source/template + plain-English summary)
  // because the wallet only shows bytecode at signing time.
  const chainId = typeof args.chain === "number" ? args.chain : typeof args.sourceChain === "number" ? (args.sourceChain as number) : null;
  // Standing rule: contract deployment ALWAYS shows the pre-deployment
  // confirmation — this includes the tools that deploy as part of their flow
  // (create_conditional_release, cross_chain_swap) even though their risk
  // class is "funds".
  const needsDeploymentConfirmation = def.risk === "deploy" || def.confirmationRequired === true;

  const step: TraceStep = {
    stepId,
    callId,
    tool: def.name,
    args,
    status: needsDeploymentConfirmation ? "awaiting_confirmation" : "running",
    title: def.traceTitle?.(args) ?? def.name,
    startedAt: Date.now(),
  };
  steps.push(step);
  emit({ type: "step_started", step });

  const actionId = startAction({
    runId,
    callId,
    tool: def.name,
    params: args,
    riskClass: def.risk,
    chainId: chainId ?? null,
    confirmationRequired: needsDeploymentConfirmation,
    sourceTxHash: typeof args.sourceTxHash === "string" ? (args.sourceTxHash as string) : null,
  });
  // Bind callId → action row so the browser's mid-flight lifecycle POSTs
  // (kind "tool_status") can patch this row while the call is parked (§4.6).
  bindCallAction(sessionId, callId, runId, actionId, def.name);

  try {
    // ── Server-side preparation for client tools (compile / fetch proofs) ───
    let contractInfo: ConfirmationRequest["contract"] | undefined;
    let preparedFeeBreakdown: Array<{ label: string; gasUnits: string; chainId?: number }> | undefined;
    if (def.executor === "client") {
      if (def.name === "deploy_contract") {
        const prepared = await prepareDeployment(args, ctx.wallet?.address ?? null);
        if (!prepared.ok) {
          patchAction(actionId, { status: "failed", result: { ok: false, summary: prepared.error ?? "deployment prep failed" } });
          emit({ type: "step_finished", stepId, status: "failed", detail: { error: prepared.error } });
          return { ok: false, summary: `Deployment could not be prepared: ${prepared.error}`, error: "prep_failed" };
        }
        contractInfo = prepared.contractInfo;
        if (prepared.compiled) {
          (args as Record<string, unknown>).__compiled = {
            artifact: {
              contractName: prepared.compiled.artifact.contractName,
              abi: prepared.compiled.artifact.abi,
              bytecode: prepared.compiled.artifact.bytecode,
            },
            constructorArgs: prepared.compiled.constructorArgs,
            payableValue: prepared.compiled.payableValue,
            chainId: prepared.compiled.chainId,
          };
        }
      } else {
        const prepared = await prepareClientTool(def.name, args, ctx.wallet?.address ?? null);
        if (!prepared.ok) {
          patchAction(actionId, { status: "failed", result: { ok: false, summary: prepared.error ?? "preparation failed" } });
          emit({ type: "step_finished", stepId, status: "failed", detail: { error: prepared.error } });
          return { ok: false, summary: `Preparation failed: ${prepared.error}`, error: "prep_failed" };
        }
        if (prepared.contractInfo) contractInfo = prepared.contractInfo;
        if (prepared.enrichedArgs) Object.assign(args, prepared.enrichedArgs);
        if (prepared.feeBreakdown) preparedFeeBreakdown = prepared.feeBreakdown;
      }
    }

    // ── Pre-deployment confirmation (deploy risk only — brief §5/§7) ─────────
    if (needsDeploymentConfirmation) {
      const request: ConfirmationRequest = {
        callId,
        stepId,
        tool: def.name,
        summary: confirmationSummary(def.name, args),
        reason: "deployment",
        chainId: chainId ?? undefined,
        txCount:
          def.name === "batch_transfer"
            ? Array.isArray(args.transfers)
              ? (args.transfers as unknown[]).length
              : 1
            : def.name === "cross_chain_swap"
              ? 4
              : 1,
        contract: contractInfo,
        feeEstimate: confirmationFeeEstimate(def.name, args, contractInfo, preparedFeeBreakdown) ?? undefined,
      };
      emit({ type: "confirmation_request", request });
      emit({ type: "step_status", stepId, status: "awaiting_confirmation", detail: { text: confirmationReasonText("deployment") } });

      const reply = await awaitResponse<"confirmation">(sessionId, callId, "confirmation", CONFIRMATION_TIMEOUT_MS, signal);
      if (!reply.approved) {
        patchAction(actionId, {
          status: "declined",
          result: { ok: false, summary: "User declined this deployment." },
        });
        step.status = "declined";
        emit({ type: "step_finished", stepId, status: "declined", result: { ok: false, summary: "Declined by user" } });
        return {
          ok: false,
          summary: "The user DECLINED this deployment. Do not retry it. Ask how they would like to proceed instead.",
          error: "declined",
        };
      }
      step.status = "running";
      emit({ type: "step_status", stepId, status: "running" });
      patchAction(actionId, { status: "running" });
    }

    // ── Execute: server tools in-process; wallet tools dispatched to browser ─
    const executeDispatch = async (): Promise<ToolOutcome> => {
      if (def.executor === "server") {
        return await runServerTool(def.name, args, ctx, (text, status) => {
          step.status = status ?? "running";
          emit({ type: "step_status", stepId, status: step.status, detail: { text } });
        });
      }
      // Pre-signature visibility (§5): the trace carries the concrete action
      // details + fee estimate while the wallet prompt is up.
      const feeEstimate = confirmationFeeEstimate(def.name, args, contractInfo, preparedFeeBreakdown);
      emit({ type: "tool_call_request", callId, stepId, tool: def.name, args });
      step.status = "awaiting_signature";
      emit({
        type: "step_status",
        stepId,
        status: "awaiting_signature",
        detail: {
          text: "Waiting for your wallet…",
          ...(feeEstimate ? { data: { feeEstimate } } : {}),
        },
      });
      const result = await awaitResponse<"tool">(sessionId, callId, "tool", TOOL_RESULT_TIMEOUT_MS, signal);
      return {
        ok: result.ok,
        summary: result.summary,
        txHash: result.txHash,
        chainId: result.chainId,
        data: result.data,
        error: result.error,
      };
    };

    let outcome = await executeDispatch();
    // ── Automatic retry for TRANSIENT failures only (§4.7, C4) ───────────────
    // One bounded retry, visible in the trace. NEVER retried: user rejection
    // (the user said no), receipt_timeout/unknown_status (a tx may be in
    // flight — resending risks a double-spend, hard boundary 7), reverts
    // (on-chain logic error), insufficient funds, missing wallet. A transient
    // code only arrives when the executor failed BEFORE broadcasting (the
    // catch path never holds a hash).
    if (
      !outcome.ok &&
      outcome.error === "transient_error" &&
      outcome.txHash === undefined
    ) {
      emit({
        type: "step_status",
        stepId,
        status: "running",
        detail: { text: "Transient network error — retrying (attempt 2 of 2)…" },
      });
      outcome = await executeDispatch();
    }

    // ── Record + emit the outcome ────────────────────────────────────────────
    // receipt_timeout/unknown_status land as the "unknown" trace status — the
    // tx WAS broadcast and its outcome is genuinely unresolved, so "failed"
    // would be a lie (the action-log row already says "unknown").
    const finalStatus: TraceStepStatus = outcome.ok
      ? "succeeded"
      : outcome.error === "receipt_timeout" || outcome.error === "unknown_status"
        ? "unknown"
        : "failed";
    const resultPayload: Record<string, unknown> = {
      ok: outcome.ok,
      summary: outcome.summary,
      ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
      ...(outcome.data ?? {}),
    };
    const finalActionStatus = outcome.ok
      ? "succeeded"
      : outcome.error === "user_rejected"
        ? "declined"
        : outcome.error === "receipt_timeout" || outcome.error === "unknown_status"
          ? "unknown"
          : "failed";
    const outcomeData = (outcome.data ?? {}) as { cc3TxHash?: string; attestRoot?: string };
    patchAction(actionId, {
      status: finalActionStatus,
      result: resultPayload,
      ...(outcome.chainId ? { chainId: outcome.chainId } : {}),
      // L1: lift the CC3 tx hash / attestation root into their columns —
      // the Actions view chips are dead UI without this.
      ...(outcomeData.cc3TxHash ? { cc3TxHash: outcomeData.cc3TxHash } : {}),
      ...(outcomeData.attestRoot ? { attestRoot: outcomeData.attestRoot } : {}),
    });
    step.status = finalStatus;
    step.finishedAt = Date.now();
    emit({
      type: "step_finished",
      stepId,
      status: finalStatus,
      result: {
        ok: outcome.ok,
        summary: outcome.summary,
        txHash: outcome.txHash,
        chainId: outcome.chainId,
        data: outcome.data,
      },
      detail: outcome.txHash
        ? {
            txHash: outcome.txHash,
            chainId: outcome.chainId,
            explorerUrl: outcome.chainId ? explorerTx(outcome.chainId, outcome.txHash) : undefined,
          }
        : undefined,
    });
    return outcome;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      patchAction(actionId, { status: "interrupted", result: { ok: false, summary: "Run interrupted before completion." } });
      step.status = "interrupted";
      emit({ type: "step_finished", stepId, status: "interrupted", result: { ok: false, summary: "Interrupted" } });
      throw err;
    }
    if (err instanceof Error && /timeout/i.test(err.message)) {
      patchAction(actionId, { status: "failed", result: { ok: false, summary: "Timed out waiting for the response." } });
      step.status = "failed";
      emit({ type: "step_finished", stepId, status: "failed", detail: { error: "timeout" } });
      return { ok: false, summary: "Timed out waiting for the wallet/user response. Ask the user whether to retry.", error: "timeout" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    patchAction(actionId, { status: "failed", result: { ok: false, summary: msg } });
    step.status = "failed";
    emit({ type: "step_finished", stepId, status: "failed", detail: { error: msg } });
    return { ok: false, summary: `Execution failed: ${msg}`, error: "execution" };
  }
}

function explorerTx(chainId: number, txHash: string): string | undefined {
  const chain = getChainByChainId(chainId);
  return chain?.explorerUrl ? `${chain.explorerUrl}/tx/${txHash}` : undefined;
}

async function runServerTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ExecContext,
  onProgress: (text: string, status?: TraceStepStatus) => void,
): Promise<ToolOutcome> {
  const st = await import("@/lib/agent/server-tools");
  const wctx = { wallet: ctx.wallet, onProgress };
  switch (name) {
    case "get_balances":
      return st.execGetBalances(args as never, wctx);
    case "get_transaction_status":
      return st.execGetTransactionStatus(args as never, wctx);
    case "check_attestation_status":
      return st.execCheckAttestation(args as never, wctx);
    case "wait_for_attestation":
      return st.execWaitForAttestation(args as never, wctx);
    case "attestcoin_network_status":
      return st.execAttestcoinNetworkStatus();
    case "list_contacts":
      return st.execListContacts();
    case "list_chains":
      return st.execListChains();
    case "list_recent_actions":
      return st.execListRecentActions(args as never);
    case "get_app_status":
      return st.execGetAppStatus(args as never, wctx);
    case "create_recurring_payment":
      return st.execCreateRecurringPayment(args as never, wctx);
    // N24: app-control tools (contacts + schedule management)
    case "create_contact":
      return st.execCreateContact(args as never);
    case "list_recurring_payments":
      return st.execListRecurringPayments(args as never);
    case "cancel_recurring_payment":
      return st.execCancelRecurringPayment(args as never);
    // P20: automation-rule tools
    case "create_automation_rule":
      return st.execCreateAutomationRule(args as never);
    case "update_automation_rule":
      return st.execUpdateAutomationRule(args as never);
    case "delete_automation_rule":
      return st.execDeleteAutomationRule(args as never);
    case "list_automation_rules":
      return st.execListAutomationRules(args as never);
    // N32: direct Attestcoin protocol tools
    case "decode_source_transaction":
      return st.execDecodeSourceTransaction(args as never);
    case "verify_proof_readonly":
      return st.execVerifyProofReadonly(args as never);
    case "estimate_verification_cost":
      return st.execEstimateVerificationCost(args as never);
    case "get_attestation_bounds":
      return st.execGetAttestationBoundsTool(args as never);
    case "submit_proof_onchain":
      return st.execSubmitProofOnchain(args as never);
    default:
      return { ok: false, summary: `Tool ${name} has no server executor.`, error: "no_executor" };
  }
}
