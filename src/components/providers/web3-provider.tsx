"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig, ensureAppKitInitialized } from "@/lib/wagmi/config";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Every surface reads live mutable state (action log, payment/
        // attestation flips, wallet activity) — the old staleTime: 60s +
        // refetchOnWindowFocus: false froze any mounted surface: a payment
        // attested or an action completed while you watched it never
        // appeared. Fresh-on-mount + refetch on focus/reconnect instead.
        staleTime: 0,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: 1,
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10_000),
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}

export function Web3Provider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(getQueryClient);

  useEffect(() => {
    ensureAppKitInitialized();
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
