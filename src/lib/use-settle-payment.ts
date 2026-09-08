"use client";

import { useCallback, useRef, useState } from "react";
import { erc20Abi, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import { useCreatePayment, useUpdatePayment } from "@/lib/api";
import type { PaymentIntent } from "@/lib/types";
import { getChainByChainId } from "@/lib/chains";

function networkLabel(chainId: number): string {
  switch (chainId) {
    case 11155111:
      return "Ethereum Sepolia";
    case 1:
      return "Ethereum Mainnet";
    default:
      return `Chain ${chainId}`;
  }
}

export type StepContext = {
  txHash?: string | null;
};

export type SettleResult =
  | {
      id: string;
      status: "settled";
      txHash: string;
    }
  | {
      id: string;
      status: "failed";
      txHash?: string;
      error: string;
    }
  | {
      id: string;
      status: "signing";
      txHash?: string;
    }
  | {
      id: string;
      status: "pending";
      reason: "no-wallet" | "no-token" | "transfer-declined";
      error?: string;
    };

export function useSettlePayment() {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const createPayment = useCreatePayment();
  const updatePayment = useUpdatePayment();
  const [isSettling, setIsSettling] = useState(false);
  const cancelRef = useRef(false);

  const settle = useCallback(
    async (
      intent: PaymentIntent,
      onStep?: (step: string, ctx?: StepContext) => void,
    ): Promise<SettleResult> => {
      setIsSettling(true);
      cancelRef.current = false;
      let createdId: string | null = null;

      try {
        if (!isConnected || !address || !chainId) {
          return { id: "", status: "pending", reason: "no-wallet" };
        }

        const isStablecoinToken = intent.token === "USDC" || intent.token === "USDC.e";
        const isNativeToken = intent.token === "ETH";

        // Payments execute on the wallet's currently connected chain. The
        // generic scaffold keeps whatever chain the user chose — a Phase 2
        // concern will be pinning source chains for the Attestcoin Protocol.
        const effectiveChainId = chainId;

        const chainConfig = getChainByChainId(effectiveChainId);

        // Resolve the ERC-20 contract address for non-native tokens.
        // - custom token: the token symbol IS the contract address (user/AI provided)
        // - USDC-style: resolve from the chain config when known
        // TODO(phase-2): token resolution will move into the Attestcoin
        // Protocol intent model (GLC/USC style assets) — keep this simple for now.
        let erc20TokenAddress: Address | null = null;
        if (!isNativeToken) {
          if (/^0x[a-fA-F0-9]{40}$/.test(intent.token)) {
            erc20TokenAddress = intent.token as Address;
          } else if (chainConfig?.stablecoin && isStablecoinToken) {
            erc20TokenAddress = chainConfig.stablecoin.address;
          } else {
            const known = chainConfig?.stablecoin;
            if (known && known.symbol.toUpperCase() === intent.token.toUpperCase()) {
              erc20TokenAddress = known.address;
            }
          }
        }

        if (!isNativeToken && !erc20TokenAddress) {
          return {
            id: "",
            status: "pending",
            reason: "no-token",
            error: `${intent.token} has no contract address on ${networkLabel(effectiveChainId)}. Provide a token contract address.`,
          };
        }

        onStep?.("creating");

        const created = await createPayment.mutateAsync({
          recipientAddress: intent.recipientAddress,
          recipientLabel: intent.recipientLabel,
          token: intent.token,
          tokenAddress: erc20TokenAddress ? erc20TokenAddress : null,
          amountHuman: intent.amountHuman,
          memo: intent.memo ?? null,
          chainId: effectiveChainId,
          senderAddress: address,
        });
        createdId = created.id;

        await updatePayment.mutateAsync({
          id: created.id,
          status: "signing",
        });

        onStep?.("transfer-signing");

        // Send the on-chain transfer.
        let txHash: string;
        try {
          if (isNativeToken) {
            txHash = await sendTransactionAsync({
              to: intent.recipientAddress as Address,
              value: BigInt(intent.amountBaseUnits),
              chainId: effectiveChainId,
            });
          } else {
            txHash = await writeContractAsync({
              address: erc20TokenAddress!,
              abi: erc20Abi,
              functionName: "transfer",
              args: [intent.recipientAddress as Address, BigInt(intent.amountBaseUnits)],
              chainId: effectiveChainId,
            });
          }
        } catch (txErr) {
          const msg = txErr instanceof Error ? txErr.message : "Transaction failed";
          if (msg.includes("rejected") || msg.includes("denied") || msg.includes("User rejected")) {
            await updatePayment.mutateAsync({ id: created.id, status: "failed" });
            onStep?.("failed");
            return { id: created.id, status: "pending", reason: "transfer-declined", error: "Transfer rejected by user." };
          }
          throw txErr;
        }

        await updatePayment.mutateAsync({
          id: created.id,
          status: "settling",
          txHash,
        });

        // Fire the txHash to the UI immediately so the user sees the transaction
        // info (explorer link, step timeline) without waiting for confirmation.
        onStep?.("confirming", { txHash });

        // Wait for on-chain confirmation.
        let onChainOk = true;
        if (publicClient) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hash, confirmations: 1 });
            onChainOk = receipt.status === "success";
          } catch {
            // Receipt timed out — tx may still be pending. Don't fail outright;
            // return "signing" so the client keeps polling the payment status.
            return { id: created.id, status: "signing", txHash };
          }
        }

        // Check for on-chain revert after waiting.
        if (!onChainOk) {
          await updatePayment.mutateAsync({ id: created.id, status: "failed", txHash });
          onStep?.("failed");
          return { id: created.id, status: "failed", txHash, error: "Transaction reverted on-chain." };
        }

        if (cancelRef.current) {
          onStep?.("failed");
          return { id: created.id, status: "failed", txHash, error: "Payment cancelled by user." };
        }

        // TODO(phase-2): wire to Attestcoin Protocol verification.
        // A coordinator "observe/verify" step used to run here (settlement
        // status polling). Phase 2 replaces it with Attestcoin Protocol
        // attestation/verification — the natural extension point is a hook
        // like `useAttestcoinVerification(paymentId, txHash)` fired in parallel
        // with confirmation, feeding a verifiable receipt back onto the intent
        // card. Until then, settlement is marked complete purely from the
        // on-chain receipt.
        await updatePayment.mutateAsync({ id: created.id, status: "settled", txHash });
        onStep?.("settled", { txHash });
        return { id: created.id, status: "settled", txHash };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Settlement failed.";
        if (createdId) {
          await updatePayment.mutateAsync({ id: createdId, status: "failed" });
        }
        onStep?.("failed");
        return { id: createdId ?? "", status: "failed", error: message };
      } finally {
        setIsSettling(false);
      }
    },
    [address, chainId, isConnected, publicClient, sendTransactionAsync, writeContractAsync, createPayment, updatePayment],
  );

  const cancelSettlement = useCallback(() => {
    cancelRef.current = true;
  }, []);

  return { settle, isSettling, cancelSettlement };
}
