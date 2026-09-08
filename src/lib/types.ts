import type { TraceStep, ConfirmationRequest } from "@/lib/agent/events";
export type PaymentStatus =
  | "parsing"
  | "clarifying"
  | "reviewing"
  | "signing"
  | "settling"
  | "settled"
  | "failed"
  | "pending"
  | "approving"
  | "deploying"
  | "sent";

export interface PaymentIntent {
  recipientLabel: string | null;
  recipientAddress: `0x${string}`;
  token: string;
  amountHuman: string;
  amountBaseUnits: string;
  memo?: string | null;
  requiresConfirmation: true;
  confidence?: number;
  aiGenerated?: boolean;
}

export type MessageRole = "user" | "assistant";

export interface ContactResult {
  id: string;
  label: string;
  address: string;
  note: string | null;
  favorite: boolean;
}

export interface PaymentHistoryResult {
  id: string;
  recipientLabel: string | null;
  recipientAddress: string;
  token: string;
  amountHuman: string;
  memo: string | null;
  status: string;
  txHash: string | null;
  chainId: number;
  createdAt: number;
}

export interface ChatMessageData {
  id: string;
  role: MessageRole;
  content: string;
  intent?: PaymentIntent;
  status?: PaymentStatus;
  txHash?: string;
  paymentId?: string;
  chainId?: number;
  createdAt: number;
  aiGenerated?: boolean;
  reasoning?: string;
  contacts?: ContactResult[];
  payments?: PaymentHistoryResult[];
  paymentStep?: string;
  streaming?: boolean;
  /** Phase 2 agent runtime: live execution trace steps for this message. */
  trace?: AgentTraceStepData[];
  /** Phase 2: an active confirmation awaiting the user's decision. */
  pendingConfirmation?: AgentPendingConfirmation;
  /** Phase 2: the run this message produced (for action-log linking). */
  runId?: string;
  /** Phase 2: finish reason once the run completed. */
  runFinish?: "stop" | "error" | "interrupted" | "max_rounds" | "invalid_loop";
  /**
   * Phase 3 (C1, §4.5): message-beat kind. Agent runs split into separate
   * messages per logical beat — "text" messages carry the model's narration
   * (announcement / result / follow-up as their own bubbles); the ONE
   * "trace" message carries the live execution trace component (and the
   * deploy confirmation card), updating in place. Legacy messages without a
   * beat render the old combined layout.
   */
  beat?: "text" | "trace";
  /**
   * Phase 3 (C23, §): context attachments the user pinned via the composer's
   * "/" command menu (e.g. /balance /chain /contacts). Rendered as chips on
   * the user bubble; expanded into the prompt text only at run time (fresh
   * data each send). No image attachments by design (§ hard boundary).
   */
  contextAttachments?: string[];
}

export type AgentTraceStepData = TraceStep;
export type AgentPendingConfirmation = ConfirmationRequest;
