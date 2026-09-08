import { NextResponse } from "next/server";

// POST /api/agent/test-connection — provider connectivity test (C28).
// Pass-through exactly like /api/models: the user's key transits this server
// bound for THEIR endpoint only, and is never persisted or logged. A minimal
// 1-token chat completion validates all three fields at once (base URL
// reachability, key validity, model existence).

interface TestBody {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export async function POST(req: Request) {
  let body: TestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "bad-request", error: "Invalid JSON body." }, { status: 400 });
  }

  const baseUrl = (body.baseUrl || "").replace(/\/+$/, "");
  const apiKey = body.apiKey || "";
  const model = (body.model || "").trim();

  if (!baseUrl || !apiKey || !model) {
    return NextResponse.json(
      { ok: false, code: "missing-fields", error: "Base URL, API key and model are all required." },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(timeout);

    if (res.ok) {
      // 200-family: the endpoint accepted key + model — connection is live.
      return NextResponse.json({ ok: true, code: "ok" });
    }

    // Map the common failure modes to actionable codes.
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { ok: false, code: "invalid-key", error: `Provider rejected the API key (HTTP ${res.status}).` },
        { status: 200 },
      );
    }
    if (res.status === 404) {
      return NextResponse.json(
        {
          ok: false,
          code: "bad-url-or-model",
          error: "Endpoint or model not found (HTTP 404). Check the base URL ends in /v1 and the model name is exact.",
        },
        { status: 200 },
      );
    }
    if (res.status === 429) {
      return NextResponse.json(
        { ok: false, code: "rate-limited", error: "Provider is rate-limiting (HTTP 429) — the endpoint itself is reachable." },
        { status: 200 },
      );
    }
    // Some providers stream validation errors in the body — surface a short slice.
    let detail = "";
    try {
      const data = (await res.json()) as { error?: { message?: string } | string };
      const msg = typeof data.error === "string" ? data.error : data.error?.message;
      if (msg) detail = ` ${msg.slice(0, 160)}`;
    } catch {
      /* body not JSON */
    }
    return NextResponse.json(
      { ok: false, code: "provider-error", error: `Provider returned HTTP ${res.status}.${detail}` },
      { status: 200 },
    );
  } catch (err) {
    clearTimeout(timeout);
    const aborted = err instanceof Error && err.name === "AbortError";
    return NextResponse.json(
      {
        ok: false,
        code: aborted ? "timeout" : "unreachable",
        error: aborted
          ? "Request timed out after 20s — the endpoint may be down or unreachable."
          : `Could not reach the endpoint: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 200 },
    );
  }
}
