// Reasoning mock for N26 showThinking QA: streams reasoning_content + text.
// Usage: bun run scripts/qa-mock-llm-reasoning.ts [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3995);

const server = createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    void body;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    for (const w of "Let me think about this transfer carefully.".split(" ")) {
      send({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: w + " " }, finish_reason: null }] });
    }
    for (const w of "Here is my answer after thinking.".split(" ")) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: w + " " }, finish_reason: null }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[qa-mock-llm-reasoning] listening on http://127.0.0.1:${port}/v1`);
});
