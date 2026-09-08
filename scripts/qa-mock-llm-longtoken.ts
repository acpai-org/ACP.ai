// Long-token mock OpenAI-compatible SSE server for browser-level QA of the
// D15/D16 wrap-anywhere fixes: streams an assistant reply whose paragraphs,
// list items, blockquote, and heading all contain unbreakable long hex
// tokens (66-char tx hashes, 42-char addresses). Before the fix these
// forced min-content widths of 500-600px and clipped off-canvas; after the
// fix every block must wrap within its container.
// Usage: bun run scripts/qa-mock-llm-longtoken.ts [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3997);

const REPLY = `## Verified transaction 0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3

The source transaction 0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3 was attested on Sepolia and released to the recipient 0x9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a on the Creditcoin chain.

Proof checkpoints:

- Source tx 0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3 on Sepolia
- Batch root 0x5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a confirmed
- Released at block 0x111213141516171819202122232425262728293031323334353637383940414243

> The precompile verifies the merkle proof against 0x5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a directly on-chain.`;

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
    console.log(`[qa-mock-llm-longtoken] request #${n}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const chunks = REPLY.match(/[\s\S]{1,40}/g) ?? [];
    for (const c of chunks) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: c }, finish_reason: null }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(port, () => {
  console.log(`[qa-mock-llm-longtoken] listening on http://localhost:${port}`);
});
