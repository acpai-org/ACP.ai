"use client";

import { useAppKit } from "@reown/appkit/react";
import { ensureAppKitInitialized } from "@/lib/wagmi/config";

export { ensureAppKitInitialized } from "@/lib/wagmi/config";

type SafeAppKit = {
  open: (o?: unknown) => Promise<unknown>;
  close: () => Promise<unknown>;
};

const APPKIT_STUB: SafeAppKit = {
  open: async () => {},
  close: async () => {},
};

export function useAppKitSafe(): SafeAppKit {
  try {
    const appKit = useAppKit();
    if (typeof window !== "undefined") ensureAppKitInitialized();
    return (appKit ?? APPKIT_STUB) as unknown as SafeAppKit;
  } catch {
    return APPKIT_STUB;
  }
}
