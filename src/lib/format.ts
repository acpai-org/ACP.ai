const MIN = 60_000;
const HR = 3_600_000;
const DAY = 86_400_000;

export function shortenAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < MIN) return "just now";
  if (diff < HR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

export function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "due now";
  if (diff < MIN) return "in <1m";
  if (diff < HR) return `in ${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `in ${Math.floor(diff / HR)}h`;
  return `in ${Math.floor(diff / DAY)}d`;
}

export function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}
