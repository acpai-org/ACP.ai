import { permanentRedirect } from "next/navigation";

// AC7 — /payments → /actions route rename.
// WHY keep this page at all: the tab shipped as /payments for the app's whole
// life — navbar bookmarks, notification deep-links shared in chats, QR codes
// printed on payment attestations and any external write-up still point at
// /payments. A 308 (permanent) redirect keeps every one of them working while
// telling crawlers/clients the canonical home is now /actions.
// Query params are forwarded by hand: permanentRedirect() does NOT append the
// incoming query string itself, and the R15 (?highlight=…) / R17 (?contact=…)
// deep-links must keep landing on the exact row they point at.
export default async function PaymentsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value)) for (const item of value) qs.append(key, item);
  }
  const query = qs.toString();
  permanentRedirect(query ? `/actions?${query}` : "/actions");
}
