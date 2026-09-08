"use client";

import { type ReactNode, memo, useState, useCallback } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
// ─────────────────────────────────────────────────────────────────────────────
// RichText — a SAFE markdown renderer for assistant messages (C20).
// Builds React elements directly — no HTML string interpolation, so nothing
// can be injected. Progressively streaming-friendly: partial markdown renders
// as whatever is already well-formed, and the streaming cursor rides inline
// at the end of the last rendered block.
//
// Supported (deliberately complete for model output):
//   ``` fenced code blocks with language label + copy affordance
//   # ## ### #### headings            > blockquotes
//   | tables | (GFM pipe)             - [ ] / - [x] task lists
//   - / * / • bullets                 1. / 1) ordered lists
//   **bold**  *italic*  `code`
//   [label](https://…) links (scheme-sanitized) + bare http(s) autolinks
//   --- / *** / ___ horizontal rules  blank-line paragraphs
// Anything unrecognized renders as plain text with pre-wrap semantics kept.
// ─────────────────────────────────────────────────────────────────────────────

const BOLD_RE = /\*\*([^*\n]+)\*\*/;
const ITALIC_RE = /(?<!\*)\*([^*\n]+)\*(?!\*)/;
const CODE_RE = /`([^`\n]+)`/;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/;
const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]]+/;
// R8: a bare EVM address (0x + exactly 40 hex, word-bounded). A 66-hex
// txHash never matches: its 41st char is a word char, so the \b fails —
// hashes render as plain text (they carry their own trace affordances).
// Non-global on purpose: renderInline's exec() must stay stateless. The
// user-bubble splitter uses its own global twin below.
const ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/;
const ADDRESS_RE_G = /\b0x[a-fA-F0-9]{40}\b/g;
const BULLET_RE = /^[-*•]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;
const TASK_RE = /^[-*•]\s+\[([ xX])\]\s*/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const QUOTE_RE = /^>\s?/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DELIM_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/;

/** Scheme allowlist for rendered links — everything else stays plain text. */
function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^ethereum:/i.test(url)) return url;
  return null;
}

/** R8: an inline EVM-address chip — mono, subtly framed, copy-on-click.
 *  Addresses are the currency of this app's transcripts (recipients, wallet
 *  IDs, verified parties); selecting-then-copying them mid-paragraph is the
 *  friction this removes. memo'd because the surrounding paragraph
 *  re-renders on every streaming chunk — the chip's props are stable.
 *  `onPrimary` adapts the palette for the inverted user bubble. */
const AddressChip = memo(function AddressChip({
  address,
  onPrimary = false,
}: {
  address: string;
  onPrimary?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(address).catch(() => {
      /* denied clipboard must not surface an unhandled rejection (R3) */
    });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? undefined : t("contacts.copyAddress")}
      aria-label={t("contacts.copyAddress")}
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 rounded-md border px-1.5 py-px align-baseline font-mono text-[0.85em] break-all transition-colors cursor-pointer",
        onPrimary
          ? copied
            ? "border-primary-foreground/60 bg-primary-foreground/20 text-primary-foreground"
            : "border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground/95 hover:border-primary-foreground/45 hover:bg-primary-foreground/20"
          : copied
            ? "border-success/50 bg-success/10 text-success"
            : "border-border/60 bg-surface-2/50 text-foreground/90 hover:border-primary/40 hover:text-primary",
      )}
    >
      <span className="break-all">{address}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 self-center text-success" aria-hidden /> : <Copy className={cn("h-3 w-3 shrink-0 self-center", onPrimary ? "opacity-70" : "opacity-50")} aria-hidden />}
    </button>
  );
});

export { AddressChip };

/** R8: user-bubble text — plain pre-wrap text (NO markdown semantics for the
 *  user's own words) with bare EVM addresses lifted into copy chips. */
export function UserText({ text }: { text: string }) {
  if (!ADDRESS_RE.test(text)) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = ADDRESS_RE_G.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<AddressChip key={`ua-${i++}`} address={m[0]} onPrimary />);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Inline formatting: bold / italic / code / links / bare URLs / address
 * chips — earliest match wins, left-to-right tokenization. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;

  while (rest.length > 0) {
    const bold = BOLD_RE.exec(rest);
    const italic = ITALIC_RE.exec(rest);
    const code = CODE_RE.exec(rest);
    const link = LINK_RE.exec(rest);
    const bare = URL_RE.exec(rest);
    const addr = ADDRESS_RE.exec(rest);

    // earliest match wins (ties: narrower constructs first)
    const candidates: Array<{ at: number; len: number; kind: "b" | "i" | "c" | "a" | "u" | "addr"; m: RegExpExecArray }> = [];
    if (bold) candidates.push({ at: bold.index, len: bold[0].length, kind: "b", m: bold });
    if (italic) candidates.push({ at: italic.index, len: italic[0].length, kind: "i", m: italic });
    if (code) candidates.push({ at: code.index, len: code[0].length, kind: "c", m: code });
    if (link) candidates.push({ at: link.index, len: link[0].length, kind: "a", m: link });
    if (bare) candidates.push({ at: bare.index, len: bare[0].length, kind: "u", m: bare });
    if (addr) candidates.push({ at: addr.index, len: addr[0].length, kind: "addr", m: addr });
    if (candidates.length === 0) {
      out.push(rest);
      break;
    }
    candidates.sort((a, b) => a.at - b.at || a.len - b.len);
    const first = candidates[0];

    if (first.at > 0) out.push(rest.slice(0, first.at));
    const inner = first.m[1];
    const key = `${keyPrefix}-${i++}`;
    if (first.kind === "b") {
      out.push(
        <strong key={key} className="font-semibold text-foreground">
          {inner}
        </strong>,
      );
    } else if (first.kind === "i") {
      out.push(
        <em key={key} className="italic">
          {inner}
        </em>,
      );
    } else if (first.kind === "c") {
      out.push(
        <code key={key} className="code-surface rounded-md px-1.5 py-0.5 font-mono text-[0.9em] break-all text-primary">
          {inner}
        </code>,
      );
    } else if (first.kind === "a") {
      // [label](url) — label + sanitized href
      const href = safeUrl(first.m[2]);
      if (href) {
        out.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary break-all"
          >
            {inner}
          </a>,
        );
      } else {
        out.push(first.m[0]);
      }
    } else if (first.kind === "addr") {
      // R8: bare EVM address — interactive copy chip (memo'd component).
      out.push(<AddressChip key={key} address={first.m[0]} />);
    } else {
      // bare http(s) URL — autolink
      const href = safeUrl(first.m[0]);
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-baseline gap-0.5 font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary break-all"
          >
            {first.m[0]}
            <ExternalLink className="h-3 w-3 shrink-0 self-center" aria-hidden />
          </a>
        ) : (
          first.m[0]
        ),
      );
    }
    rest = rest.slice(first.at + first.len);
  }
  return out;
}

/** Split a table row on unescaped pipes; trims cells. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const HEADING_SIZES: Array<string> = [
  "text-[17px] font-semibold tracking-tight wrap-anywhere",
  "text-[16px] font-semibold tracking-tight wrap-anywhere",
  "text-[15px] font-semibold wrap-anywhere",
  "text-[14px] font-semibold text-foreground/90 wrap-anywhere",
];

/** Cursor-attachable block record (N22): flush functions emit their element
 * plus an `attach` closure that rebuilds the SAME element with the streaming
 * cursor appended. After parsing completes, the cursor is attached to the
 * LAST cursor-capable block only — it must never blink at the end of already
 * completed paragraphs/lists/quotes above the live end. */
interface BlockRec {
  node: ReactNode;
  attach?: (cursor: ReactNode) => ReactNode;
}

/** P12: append the streaming entrance class while a message streams. React
 * reuses keyed DOM nodes across chunks, so the animation only plays for
 * genuinely NEW blocks — never for completed content above the live end. */
function streamCls(cls: string, streaming: boolean | undefined): string {
  return streaming ? `${cls} stream-in` : cls;
}

/** One text block (no fences): all block-level markdown. The cursor (when
 * streaming) rides inline at the end of the LAST block. */
function renderTextBlock(text: string, keyPrefix: string, cursor?: ReactNode, streaming?: boolean): ReactNode[] {
  const out: BlockRec[] = [];
  const lines = text.split("\n");
  let list: ListState | null = null;
  let para: string[] = [];
  let quote: string[] | null = null;
  let i = 0;

  interface ListState {
    ordered: boolean;
    items: string[];
    tasks: Array<{ done: boolean; text: string }> | null;
  }

  const flushPara = () => {
    if (para.length === 0) return;
    const joined = para.join("\n").trim();
    if (joined.length > 0) {
      const key = `${keyPrefix}-p${i++}`;
      const cls = streamCls("whitespace-pre-wrap wrap-anywhere", streaming);
      const inline = () => renderInline(joined, `${keyPrefix}-p${i}`);
      out.push({
        node: <p key={key} className={cls}>{inline()}{null}</p>,
        attach: (c) => <p key={key} className={cls}>{inline()}{c}</p>,
      });
    }
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const current = list;
    if (current.tasks) {
      const key = `${keyPrefix}-l${i++}`;
      const renderTasks = (c?: ReactNode) => (
        <ul key={key} className={streamCls("space-y-1", streaming)}>
          {current.tasks!.map((item, j) => (
            <li key={`${keyPrefix}-li${i}-${j}`} className="flex items-start gap-2 whitespace-pre-wrap wrap-anywhere">
              <span
                aria-hidden
                className={
                  "mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border " +
                  (item.done
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border bg-surface-2/40")
                }
              >
                {item.done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
              </span>
              <span className={item.done ? "text-muted line-through decoration-muted/50" : ""}>
                {renderInline(item.text, `${keyPrefix}-li${i}-${j}`)}
                {c && j === current.tasks!.length - 1 ? c : null}
              </span>
            </li>
          ))}
        </ul>
      );
      out.push({ node: renderTasks(), attach: renderTasks });
    } else {
      const key = `${keyPrefix}-l${i++}`;
      const renderList = (c?: ReactNode) => {
        const items = current.items.map((item, j) => (
          <li key={`${keyPrefix}-li${i}-${j}`} className="whitespace-pre-wrap wrap-anywhere">
            {renderInline(item, `${keyPrefix}-li${i}-${j}`)}
            {c && j === current.items.length - 1 ? c : null}
          </li>
        ));
        return current.ordered ? (
          <ol key={key} className={streamCls("ml-4 list-decimal space-y-1", streaming)}>
            {items}
          </ol>
        ) : (
          <ul key={key} className={streamCls("ml-4 list-disc space-y-1 marker:text-primary/70", streaming)}>
            {items}
          </ul>
        );
      };
      out.push({ node: renderList(), attach: renderList });
    }
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    const current = quote;
    const joined = current.join("\n").trim();
    if (joined.length > 0) {
      const key = `${keyPrefix}-q${i++}`;
      const renderQ = (c?: ReactNode) => (
        <blockquote
          key={key}
          className={streamCls("my-1 rounded-r-xl border-l-2 border-primary/35 bg-primary/[0.05] px-3.5 py-2 text-[13.5px] leading-relaxed text-muted wrap-anywhere", streaming)}
        >
          {renderInline(joined, `${keyPrefix}-q${i}`)}
          {c ?? null}
        </blockquote>
      );
      out.push({ node: renderQ(), attach: renderQ });
    }
    quote = null;
  };
  const flushAll = () => {
    flushList();
    flushPara();
    flushQuote();
  };

  let k = 0;
  while (k < lines.length) {
    const line = lines[k];

    // Horizontal rule
    if (HR_RE.test(line.trim())) {
      flushAll();
      out.push({
        node: <hr key={`${keyPrefix}-hr${i++}`} className="my-2.5 border-0 border-t border-border/60" aria-hidden />,
      });
      k++;
      continue;
    }

    // ATX heading
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 4);
      const key = `${keyPrefix}-h${i++}`;
      const cls = streamCls(HEADING_SIZES[level - 1], streaming);
      out.push({
        node: (
          <p key={key} className={cls}>
            {renderInline(heading[2].trim(), `${keyPrefix}-h${i}`)}
          </p>
        ),
        attach: (c) => (
          <p key={key} className={cls}>
            {renderInline(heading[2].trim(), `${keyPrefix}-h${i}`)}{c}
          </p>
        ),
      });
      k++;
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      flushList();
      flushPara();
      if (!quote) quote = [];
      quote.push(line.replace(QUOTE_RE, ""));
      k++;
      continue;
    }

    // GFM table: a pipe-bearing line followed by a delimiter row
    if (line.includes("|") && k + 1 < lines.length && TABLE_DELIM_RE.test(lines[k + 1].trim())) {
      flushAll();
      const header = splitRow(line);
      k += 2;
      const rows: string[][] = [];
      while (k < lines.length && lines[k].includes("|") && lines[k].trim().length > 0) {
        rows.push(splitRow(lines[k]));
        k++;
      }
      out.push({
        node: (
          <div key={`${keyPrefix}-tb${i++}`} className={streamCls("my-1.5 overflow-x-auto acp-scroll", streaming)}>
            <table className="w-full border-collapse text-[13px] leading-snug">
              <thead>
                <tr>
                  {header.map((h, j) => (
                    <th
                      key={j}
                      scope="col"
                      className="whitespace-nowrap border-b border-border/70 px-2.5 py-1.5 text-left font-semibold text-foreground/90"
                    >
                      {renderInline(h, `${keyPrefix}-th${i}-${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri} className="border-b border-border/30 last:border-0">
                    {header.map((_, j) => (
                      <td key={j} className="px-2.5 py-1.5 align-top text-foreground/85">
                        {r[j] !== undefined ? renderInline(r[j], `${keyPrefix}-td${i}-${ri}-${j}`) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      });
      continue;
    }

    // Task list item (- [ ] / - [x])
    const task = TASK_RE.exec(line);
    if (task) {
      flushPara();
      flushQuote();
      if (!list || !list.tasks) {
        flushList();
        list = { ordered: false, items: [], tasks: [] };
      }
      list.tasks!.push({
        done: task[1].toLowerCase() === "x",
        text: line.replace(TASK_RE, "").trim(),
      });
      k++;
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushPara();
      flushQuote();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered || list.tasks) {
        flushList();
        list = { ordered: isOrdered, items: [], tasks: null };
      }
      list.items.push(line.replace((bullet ?? ordered!)[0], "").trim());
      k++;
      continue;
    }

    if (line.trim().length === 0) {
      flushList();
      flushPara();
      flushQuote();
      k++;
      continue;
    }

    flushList();
    flushQuote();
    para.push(line);
    k++;
  }
  flushAll();

  // N22: attach the streaming cursor to the LAST cursor-capable block only.
  // Every earlier paragraph/list/quote is COMPLETE — a blinking cursor there
  // was the reported defect (cursor blinking on completed paragraphs).
  if (cursor) {
    for (let r = out.length - 1; r >= 0; r--) {
      const rec = out[r];
      if (rec.attach) {
        out[r] = { node: rec.attach(cursor) };
        break;
      }
    }
  }
  return out.map((r) => r.node);
}

/** A fenced code block with a header bar (language label + copy). */
function CodeBlock({ body, lang, k, streaming }: { body: string; lang: string | null; k: string; streaming?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [body]);
  return (
    <div key={k} className={streamCls("code-surface group/code my-1.5 overflow-hidden rounded-xl", streaming)}>
      <div className="flex items-center justify-between border-b border-border/40 py-1 pl-3.5 pr-2">
        <span className="font-mono text-[10.5px] font-medium uppercase tracking-wider text-muted-2" aria-hidden>
          {lang ?? "text"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100"
          aria-label={t("common.copy")}
          title={t("common.copy")}
        >
          {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
        </button>
      </div>
      <pre className="acp-scroll overflow-x-auto px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-foreground/90">
        <code>{body}</code>
      </pre>
    </div>
  );
}

export const RichText = memo(function RichText({ text, cursor, streaming }: { text: string; cursor?: ReactNode; streaming?: boolean }) {
  // Split out fenced code blocks first.
  const segments = text.split(/```/);
  const blocks: ReactNode[] = [];

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (s % 2 === 1) {
      // Fenced code. The first line is the language ONLY when the ENTIRE
      // first line matches the lang pattern — a partial-word match must never
      // strip body content (the old `/^[a-zA-Z0-9+#._-]*\n?/` regex ate the
      // first word of a no-language block whose first line contained a space:
      // "hello world\nfoo" became " world\nfoo").
      const nl = seg.indexOf("\n");
      const firstLine = (nl >= 0 ? seg.slice(0, nl) : seg).trim();
      const looksLikeLang = /^[a-zA-Z0-9+#._-]{1,20}$/.test(firstLine);
      const lang = looksLikeLang ? firstLine.toLowerCase() : null;
      const body = looksLikeLang
        ? (nl >= 0 ? seg.slice(nl + 1) : "").replace(/\n$/, "")
        : // No language line: the fence's own line terminator (ONE leading
          // \n) is fence syntax, not code — strip exactly one, then the
          // single trailing newline before the closing fence.
          seg.replace(/^\n/, "").replace(/\n$/, "");
      blocks.push(<CodeBlock key={`code-${s}`} body={body} lang={lang} k={`code-${s}`} streaming={streaming} />);
    } else if (seg.trim().length > 0) {
      blocks.push(...renderTextBlock(seg, `t${s}`, s === segments.length - 1 ? cursor : undefined, streaming));
    }
  }

  // Cursor with no text yet — render it standalone so it's visible.
  if (blocks.length === 0 && cursor) blocks.push(cursor);

  return <div className="flex flex-col gap-1.5 empty:hidden">{blocks}</div>;
});
