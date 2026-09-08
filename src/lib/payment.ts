import { isAddress, parseUnits } from "viem";
import type { PaymentInsert, ContactInsert } from "@/db/schema";

export type PaymentStatus =
  | "pending"
  | "signing"
  | "settling"
  | "settled"
  | "failed";

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function newPaymentId(): string {
  return randomId("p");
}

export function newContactId(): string {
  return randomId("c");
}

export interface CreatePaymentInput {
  recipientAddress: string;
  recipientLabel?: string | null;
  token?: string;
  tokenAddress?: string | null;
  amountHuman: string;
  memo?: string | null;
  chainId?: number;
  senderAddress?: string | null;
}

export type ValidationResult =
  | { ok: true; data: PaymentInsert }
  | { ok: false; error: string };

export function validateCreatePayment(
  input: Partial<CreatePaymentInput>,
): ValidationResult {
  const recipientAddress = (input.recipientAddress ?? "").trim();
  if (!recipientAddress || !isAddress(recipientAddress)) {
    return { ok: false, error: "A valid 0x recipient address is required." };
  }

  const amountHuman = (input.amountHuman ?? "").trim();
  const amountNum = parseFloat(amountHuman);
  if (!amountHuman || Number.isNaN(amountNum) || amountNum <= 0) {
    return { ok: false, error: "Amount must be a positive number." };
  }

  const token = (input.token ?? "USDC").toUpperCase();
  const tokenAddress = input.tokenAddress?.trim() || null;
  const decimals = (token === "USDC" || token === "USDC.E") ? 6 : 18;
  let amountBaseUnits: string;
  try {
    amountBaseUnits = parseUnits(amountHuman, decimals).toString();
  } catch {
    return { ok: false, error: "Amount has too many decimal places." };
  }

  const chainId =
    typeof input.chainId === "number" && input.chainId > 0
      ? input.chainId
      : 133;

  const data: PaymentInsert = {
    id: newPaymentId(),
    recipientAddress,
    recipientLabel: input.recipientLabel?.trim() || null,
    token,
    tokenAddress: tokenAddress as PaymentInsert["tokenAddress"],
    amountHuman,
    amountBaseUnits,
    memo: input.memo?.trim() || null,
    status: "pending",
    txHash: null,
    chainId,
    senderAddress: input.senderAddress ?? null,
    createdAt: Date.now(),
    settledAt: null,
  };

  return { ok: true, data };
}

export interface CreateContactInput {
  label: string;
  address: string;
  note?: string | null;
  favorite?: boolean;
}

export function validateCreateContact(
  input: Partial<CreateContactInput>,
): { ok: true; data: ContactInsert } | { ok: false; error: string } {
  const label = (input.label ?? "").trim();
  if (!label) {
    return { ok: false, error: "Contact name is required." };
  }

  const address = (input.address ?? "").trim();
  if (!address || !isAddress(address)) {
    return { ok: false, error: "A valid 0x address is required." };
  }

  const data: ContactInsert = {
    id: newContactId(),
    label,
    address,
    note: input.note?.trim() || "",
    favorite: input.favorite ?? false,
    // 0 = never used — "last used" flips on the first real payment dispatch
    // (see the transfer/agent flows that bump lastUsed), not on creation.
    lastUsed: 0,
  };

  return { ok: true, data };
}
