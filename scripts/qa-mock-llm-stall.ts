// Stall mock for N22 honesty QA: sends two words then goes SILENT without
// closing the stream. The chat must show the honest "stream stalled" hint
// after the 15s no-progress window (and never before).
// Usage: bun run scripts/qa-mock-llm-stall.ts [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3996);

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    void body;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ choices: [{ index: 0, delta: { role: "assistant", content: "Starting " }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: { role: "assistant", content: "now. " }, finish_reason: null }] });
    // then silence — never end the response (client watches the stall hint)
    console.log(`[qa-mock-llm-stall] served 2 words, now silent forever`);
    res.on("close", () => console.log(`[qa-mock-llm-stall] client disconnected`));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[qa-mock-llm-stall] listening on http://127.0.0.1:${port}/v1`);
});
