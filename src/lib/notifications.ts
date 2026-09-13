import { randomUUID } from "node:crypto";
import { db } from "@/db/index";
import { notifications } from "@/db/schema";
import { shortenAddress } from "@/lib/format";

export type NotificationType = "payment" | "security" | "system";

export type PaymentNotificationEvent =
  | "initiated"
  | "settling"
  | "settled"
  | "failed"
  | "attested";

/**
 * Notification rows store TRANSLATION KEYS, not display strings:
 *   title   = "notifications.event.<event>"   (a TranslationKey)
 *   message = JSON.stringify(params)          ({amount, token, recipient})
 * The notifications page renders them through t() in the active locale, so
 * content is correct in en/ja/ko/zh no matter which language the user had
 * active when the event was recorded. Rows whose title is not a known event
 * key are rendered verbatim (raw string passthrough).
 *
 * The "attested" event is fired by the server-side Attestcoin poller
 * (src/lib/attestcoin/poller.ts) when a settled payment's Merkle + continuity
 * proof first becomes available on the Creditcoin proof builder.
 */
export function createNotification(
  title: string,
  message: string,
  type: NotificationType,
  relatedPaymentId?: string,
) {
  const id = randomUUID();
  db.insert(notifications)
    .values({
      id,
      title,
      message,
      type,
      read: false,
      relatedPaymentId: relatedPaymentId ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function createPaymentNotification(
  event: PaymentNotificationEvent,
  token: string,
  amountHuman: string,
  recipientLabel: string,
  paymentId: string,
): string {
  // AC8: returns the notification id (pass-through) so the action variant
  // below can delegate here without duplicating the row shape.
  return createNotification(
    `notifications.event.${event}`,
    JSON.stringify({ amount: amountHuman, token, recipient: recipientLabel }),
    "payment",
    paymentId,
  );
}

// ── AC8: attestation notifications for agent ACTIONS ──────────────────────────
// The poller now attestation-tracks agent_actions rows (deploys, transfers,
// escrow locks…) in addition to payments. A dedicated title key
// ("notifications.event.actionAttested") would render as a RAW string in the
// notifications page: its localized-rendering whitelist (EVENT_KEY in
// app/notifications/page.tsx) only accepts the five payment events, and that
// file is owned by a concurrent task. So this reuses the ALREADY-whitelisted
// "attested" event shape — the title renders localized ("Attestation ready"
// etc.) in every locale with zero page changes — with the humanized tool name
// as the subject and the shortened tx hash as the object.
const ACTION_TOOL_SUBJECTS: Record<string, string> = {
  transfer: "Agent transfer",
  batch_transfer: "Agent batch transfer",
  deploy_contract: "Contract deployment",
  create_conditional_release: "Escrow lock",
  execute_conditional_release: "Conditional release",
  cross_chain_swap: "Cross-chain swap",
  payment_settle: "Payment settlement",
};

/** Human-facing subject for an attested action row (raw tool id as fallback). */
export function actionNotificationSubject(tool: string): string {
  return ACTION_TOOL_SUBJECTS[tool] ?? tool;
}

/**
 * "Attestation ready" notification for an attested agent action (AC8).
 * Renders via the same translation-key scheme as payment events: title is the
 * whitelisted `notifications.event.attested` key, message is JSON params
 * ({amount: subject, token: "", recipient: short tx hash}) consumed by the
 * `notifications.eventMsg.attested` template in the active locale.
 * `actionId` rides relatedPaymentId so the row can deep-link later.
 */
export function createActionAttestedNotification(
  tool: string,
  txHash: string,
  actionId: string,
): string {
  return createPaymentNotification(
    "attested",
    "",
    actionNotificationSubject(tool),
    shortenAddress(txHash),
    actionId,
  );
}