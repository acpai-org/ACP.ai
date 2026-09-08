import { randomUUID } from "node:crypto";
import { db } from "@/db/index";
import { notifications } from "@/db/schema";

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
) {
  createNotification(
    `notifications.event.${event}`,
    JSON.stringify({ amount: amountHuman, token, recipient: recipientLabel }),
    "payment",
    paymentId,
  );
}
