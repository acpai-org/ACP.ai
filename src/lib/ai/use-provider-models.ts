"use client";

import { useCallback, useEffect, useState } from "react";

export interface ProviderModelsState {
  models: string[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

// N10 fix: module-level TTL cache for the model list. POST /api/models
// carries the user's API key and fires on EVERY ChatView/ModelPicker mount —
// with no caching that's a per-mount upstream round-trip (and a hang with no
// timeout). Cached entries are keyed on (baseUrl, apiKey) and live for 5 min;
// a manual refetch bypasses the cache.
interface CacheEntry {
  at: number;
  models: string[];
}
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const modelCache = new Map<string, CacheEntry>();

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
      // Fresh-enough cache hit: serve instantly, no upstream call.
      const cacheKey = `${baseUrl}\n${apiKey}`;
      const hit = modelCache.get(cacheKey);
      const useCache = nonce === 0 && hit && Date.now() - hit.at < MODEL_CACHE_TTL_MS;
      if (useCache) {
        if (cancelled) return;
        setModels(hit.models);
        setError(null);
        setLoading(false);
        return;
      }
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        // N10: bounded request — a slow provider endpoint must not leave the
        // picker in "loading…" forever.
        const res = await fetch("/api/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey }),
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
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
        const list = Array.isArray(data.models) ? data.models : [];
        setModels(list);
        setError(data.empty ? "No models returned by this endpoint. You can enter a model name manually." : null);
        if (list.length > 0) {
          modelCache.set(cacheKey, { at: Date.now(), models: list });
        }
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
