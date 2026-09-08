"use client";

import { useCallback, useEffect, useState } from "react";

export interface ProviderModelsState {
  models: string[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useProviderModels(baseUrl: string, apiKey: string): ProviderModelsState {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!baseUrl || !apiKey) {
        if (cancelled) return;
        setModels([]);
        setError(null);
        setLoading(false);
        return;
      }
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey }),
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setError(data.error ?? `HTTP ${res.status}`);
          setModels([]);
          return;
        }
        const data = (await res.json()) as { models?: string[]; empty?: boolean };
        if (cancelled) return;
        setModels(Array.isArray(data.models) ? data.models : []);
        setError(data.empty ? "No models returned by this endpoint. You can enter a model name manually." : null);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Network error fetching models.";
        setError(`${msg} You can enter a model name manually.`);
        setModels([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiKey, nonce]);

  return { models, loading, error, refetch };
}
