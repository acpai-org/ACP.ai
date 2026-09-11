import { NextResponse, type NextRequest } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// Proxy (Next 16 — previously "middleware"): API responses are NEVER
// cacheable — not by the browser, not by a CDN, not by anything between the
// app and the user. Every surface reads live mutable state (the action log,
// payment/attestation flips, wallet activity), so a cached response is a
// wrong response.
//
// This stamps the HTTP layer for every /api/* response. The route handlers
// additionally export `dynamic = "force-dynamic"` + `revalidate = 0` so the
// Next data layer never serves a prerendered copy either.
// ─────────────────────────────────────────────────────────────────────────────

export default function proxy(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
