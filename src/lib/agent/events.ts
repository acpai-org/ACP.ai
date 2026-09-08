// ─────────────────────────────────────────────────────────────────────────────
// Agent event protocol (server → client, NDJSON lines on POST /api/agent/run).
//
// The client → server half is POST /api/agent/respond with:
//   { sessionId, callId, kind: "tool_result", result }
//   { sessionId, callId, kind: "confirmation", approved: boolean }
// ─────────────────────────────────────────────────────────────────────────────

export type TraceStepStatus =
  | "pending"
  | "running"
  | "awaiting_signature"
  | "awaiting_confirmation"
  | "awaiting_user"
  | "waiting_attestation"
  | "broadcast"
  | "confirming"
  | "succeeded"
  | "failed"
  | "skipped"
  | "declined"
  | "interrupted";

export interface TraceStepDetail {
  /** Human-readable line for the step body (i18n'd client-side by key where possible). */
  text?: string;
  txHash?: string;
  chainId?: number;
  explorerUrl?: string;
  address?: string;
  blockNumber?: number;
  merkleRoot?: string;
  error?: string;
  usdValue?: number;
  /** Arbitrary extra payload for specific tools. */
  data?: Record<string, unknown>;
}

/** One tool execution inside a run — the live execution trace (brief §2). */
export interface TraceStep {
  stepId: string;
  /** callId for client-dispatched tools; also used in tool_call_request/confirmation. */
  callId: string;
  tool: string;
  /** Already-validated args (post-zod). */
  args: Record<string, unknown>;
  status: TraceStepStatus;
  title?: string;
  detail?: TraceStepDetail;
  startedAt?: number;
  finishedAt?: number;
  /** Final result summary for the step. */
  result?: { ok: boolean; summary: string; txHash?: string; chainId?: number; data?: Record<string, unknown> };
}

/** Contract-specific payload for deployment confirmations (brief §6). */
export interface ContractConfirmationInfo {
  template?: string;
  source: string;
  plainSummary: string;
  warnings?: string[] | null;
  estimatedGas?: string;
}

export interface ConfirmationRequest {
  callId: string;
  stepId: string;
  tool: string;
  /** Human summary of what will happen. */
  summary: string;
  /** Why confirmation is required. Phase 3 §5: the wallet signature is the
   * confirmation for routine fund actions — the only in-app confirmation
   * left is contract deployment (source/template + plain-English summary
   * before bytecode goes on-chain). */
  reason: "deployment";
  usdValue?: number;
  chainId?: number;
  txCount?: number;
  contract?: ContractConfirmationInfo;
  /**
   * Deterministic gas-UNITS estimate for the whole action (brief §5 fee row).
   * The client combines it with a live gas price at render time. Gas units
   * travel as decimal strings (bigint-safe over the wire).
   */
  feeEstimate?: {
    gasUnits: string;
    breakdown?: Array<{ label: string; gasUnits: string; chainId?: number }>;
  };
}

export type AgentStreamEvent =
  | { type: "run_started"; runId: string; sessionId: string }
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "text_done" }
  | { type: "step_started"; step: TraceStep }
  | { type: "step_status"; stepId: string; status: TraceStepStatus; detail?: TraceStepDetail }
  | { type: "step_finished"; stepId: string; status: TraceStepStatus; result?: TraceStep["result"]; detail?: TraceStepDetail }
  | {
      type: "tool_call_request";
      callId: string;
      stepId: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | { type: "confirmation_request"; request: ConfirmationRequest }
  | { type: "intent"; intent: unknown }
  | { type: "plan"; text: string }
  | { type: "debug"; msg: string; [k: string]: unknown }
  | { type: "error"; error: string; code?: string }
  | { type: "run_finished"; finishReason: "stop" | "error" | "interrupted" | "max_rounds" | "invalid_loop"; steps: TraceStep[] };

/** Legacy-compat: the old /api/chat protocol events the client already knows. */
export type AgentRespondBody =
  | { sessionId: string; callId: string; kind: "tool_result"; result: ToolClientResult }
  | { sessionId: string; callId: string; kind: "confirmation"; approved: boolean; rememberChoice?: boolean }
  | {
      sessionId: string;
      callId: string;
      kind: "tool_status";
      status: "requested" | "signed" | "broadcast" | "confirmed" | "rejected" | "failed" | "timeout" | "unknown";
      txHash?: string;
      chainId?: number;
      blockNumber?: number;
      error?: string;
    };

export interface ToolClientResult {
  ok: boolean;
  /** Compact human summary shown in the trace + fed to the model. */
  summary: string;
  txHash?: string;
  chainId?: number;
  address?: string;
  error?: string;
  data?: Record<string, unknown>;
}
