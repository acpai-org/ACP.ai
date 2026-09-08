// Markdown-rich mock OpenAI-compatible SSE server for browser-level QA of
// the RichText renderer (C20). ANY chat completion request gets a single
// round with the full markdown feature set: headings, table, links, bare
// URLs, fenced code (with language), task lists, bullets, ordered list,
// blockquote, horizontal rule, bold/italic/inline code.
// Usage: bun run scripts/qa-mock-llm-md.ts [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3998);

const MARKDOWN = `## Attestcoin Protocol Overview

The **Attestcoin Protocol** verifies cross-chain state with *on-chain proofs*. See the [Creditcoin explorer](https://creditcoin-testnet.blockscout.com) or https://prover.cc3-testnet.creditcoin.network for the live prover.

### Supported source chains

| Chain | chainId | chainKey | Type |
| --- | --- | --- | --- |
| Sepolia | 11155111 | 1 | Testnet |
| Ethereum | 1 | 3 | Mainnet |
| Base | 8453 | — | Mainnet |

> Proofs are verified by the \`BlockProver\` precompile at
> \`0x…FD2\` on the Creditcoin chain — no off-chain trust.

\`\`\`solidity
(bool ok, bytes memory result) = BLOCK_PROVER.staticcall(
    abi.encodeWithSelector(Prover.verifySingle.selector, proof)
);
require(ok, "proof rejected");
\`\`\`

Your setup checklist:

- [x] Wallet connected
- [x] RPC reachable
- [ ] tCTC test funds acquired
- [ ] First proof submitted

---

1. Lock funds on the source chain
2. Wait for attestation
3. Release on the destination chain

Ready when you are.`;

let n = 0;

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    n++;
    console.log(`[qa-mock-llm-md] request #${n} body head: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
    // Log the LAST user message in full (context-attachment verification).
    try {
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "user");
      if (lastUser) {
        console.log(`[qa-mock-llm-md] LAST USER MESSAGE >>>\n${lastUser.content.slice(0, 2500)}\n<<< END`);
      }
    } catch {
      /* not JSON */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    // Stream in small fragments to exercise progressive markdown rendering.
    const chunks = MARKDOWN.match(/[\s\S]{1,40}/g) ?? [];
    for (const c of chunks) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: c }, finish_reason: null }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(port, () => {
  console.log(`[qa-mock-llm-md] listening on http://localhost:${port} — every request answers with the markdown fixture`);
});
