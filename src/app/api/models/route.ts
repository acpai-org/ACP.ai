import { NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// Model list proxy (P2): fetches the provider's /models endpoint ON BEHALF of
// the browser (the API key never leaves the server for the browser's CORS
// surface it already knows) and returns the COMPLETE list in a deterministic
// order. P2 hardening:
//   • one bounded retry on transient failure (5xx / network / timeout) —
//     load-balanced gateways sometimes serve a partial node response;
//   • pagination follow when the payload advertises more pages
//     (has_more / next_page / cursor), bounded at 5 pages;
//   • response-shape tolerance: bare array, {models}, {data},
//     {data:{models}}, entries as strings or {id|name|model};
//   • deterministic case-insensitive sort with a stable tiebreak;
//   • dedupe.
// The result is honest: errors are errors (with the manual-entry hint),
// an empty list is explicitly flagged `empty` — never a partial list
// presented as complete.
// ─────────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 800;
const MAX_PAGES = 5;

interface RawModelEntry {
  id?: string;
  name?: string;
  model?: string;
}

/** Extract the model-id strings from one fetched payload. */
function extractIds(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return idsFromEntries(payload as unknown[]);
  }
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const listRaw =
      Array.isArray(p.models) ? p.models
      : Array.isArray(p.data) ? p.data
      : p.data && typeof p.data === "object" && Array.isArray((p.data as Record<string, unknown>).models)
        ? (p.data as Record<string, unknown>).models
        : p.data && typeof p.data === "object" && Array.isArray((p.data as Record<string, unknown>).data)
          ? (p.data as Record<string, unknown>).data
          : [];
    return idsFromEntries(listRaw as unknown[]);
  }
  return [];
}

function idsFromEntries(entries: unknown[]): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    if (typeof e === "string") {
      if (e.length > 0) ids.push(e);
    } else if (e && typeof e === "object") {
      const entry = e as RawModelEntry;
      const id = entry.id ?? entry.model ?? entry.name;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

/** Detect an advertised next page (OpenAI-compatible gateways vary). */
function nextPageCursor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.has_more === false) return null;
  if (typeof p.next_page === "string" && p.next_page.length > 0) return p.next_page;
  if (typeof p.cursor === "string" && p.cursor.length > 0) return p.cursor;
  if (typeof p.after === "string" && p.after.length > 0) return p.after;
  if (p.has_more === true) return "continue";
  return null;
}

async function fetchModelsOnce(
  modelsUrl: string,
  apiKey: string,
  cursor: string | null,
): Promise<{ payload: unknown; status: number; ok: boolean; networkError?: string }> {
  const url = cursor && cursor !== "continue" ? `${modelsUrl}${modelsUrl.includes("?") ? "&" : "?"}after=${encodeURIComponent(cursor)}` : modelsUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return { payload, status: res.status, ok: res.ok };
  } catch (err) {
    clearTimeout(timeout);
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { payload: null, status: 0, ok: false, networkError: aborted ? "timeout" : "network" };
  }
}

/** Fetch with one bounded retry for transient failures (5xx / network / timeout). */
async function fetchModelsWithRetry(
  modelsUrl: string,
  apiKey: string,
  cursor: string | null,
): Promise<{ payload: unknown; status: number; ok: boolean; networkError?: string; retried: boolean }> {
  const first = await fetchModelsOnce(modelsUrl, apiKey, cursor);
  const transient = !first.ok && (first.status >= 500 || first.status === 0 || first.status === 429);
  if (!transient) return { ...first, retried: false };
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  const second = await fetchModelsOnce(modelsUrl, apiKey, cursor);
  // The retry result wins when it succeeded OR when it produced a payload —
  // otherwise surface the original error.
  if (second.ok || second.payload != null) return { ...second, retried: true };
  return { ...first, retried: true };
}

export async function POST(req: Request) {
  let body: { baseUrl?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const baseUrl = (body.baseUrl || "").replace(/\/+$/, "");
  const apiKey = body.apiKey || "";

  if (!baseUrl) {
    return NextResponse.json({ error: "No base URL provided." }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "No API key provided." }, { status: 400 });
  }

  const modelsUrl = `${baseUrl}/models`;
  const ids = new Set<string>();
  let lastError: string | null = null;
  let retriedAny = false;
  let cursor: string | null = null;
  let pages = 0;

  // Pagination loop (bounded) + retry per page.
  do {
    const fetched = await fetchModelsWithRetry(modelsUrl, apiKey, cursor);
    if (fetched.retried) retriedAny = true;
    if (!fetched.ok) {
      if (ids.size === 0) {
        // No partial result to show — an honest error.
        if (fetched.networkError === "timeout") {
          return NextResponse.json({ error: "Request timed out. You can enter a model name manually." }, { status: 408 });
        }
        if (fetched.networkError === "network") {
          return NextResponse.json(
            { error: "Could not reach the provider after one retry. Check the base URL; you can enter a model name manually." },
            { status: 502 },
          );
        }
        return NextResponse.json(
          {
            error:
              fetched.status === 401
                ? "Invalid API key for this provider."
                : `Provider returned HTTP ${fetched.status}${retriedAny ? " (after retry)" : ""}.`,
          },
          { status: fetched.status || 502 },
        );
      }
      // A later page failed but earlier pages produced models — return what
      // we honestly have, flagged as possibly partial.
      lastError = `later page failed (HTTP ${fetched.status})`;
      break;
    }
    for (const id of extractIds(fetched.payload)) ids.add(id);
    cursor = nextPageCursor(fetched.payload);
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  // Deterministic order: case-insensitive locale compare + stable tiebreak.
  const unique = [...ids].sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al !== bl) return al.localeCompare(bl);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return NextResponse.json({
    models: unique,
    empty: unique.length === 0,
    pages,
    ...(retriedAny ? { retried: true } : {}),
    ...(lastError ? { partial: lastError } : {}),
  });
}
