// N25 QA mock (one-off): exercises the trace ARGS panel with rich arg shapes —
// get_balances {chain: null} (→ "All chains" row) and create_recurring_payment
// (chain name / grouped amount / cadence label / memo / hash row / executions).
// Usage: bun run scripts/qa-mock-llm-n25-args.ts [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3996);
let n = 0;
const ADDR = "0x9F8a7B6c5d4E3F2A1B0c9d8E7f6A5b4c3D2E1f0a";

const server = createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (body.includes('"ping"')) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      console.log("[qa-n25] probe skipped");
      return;
    }
    n++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    if (n === 1) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: "Checking balances across your chains. " }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_n25_1", type: "function", function: { name: "get_balances", arguments: JSON.stringify({ chain: null }) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else if (n === 2) {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: "Now scheduling a monthly payment for QA. " }, finish_reason: null }] });
      const args = JSON.stringify({ recipient: ADDR, token: "USDC", amount: "1234.5", chain: 11155111, cadence: "monthly", memo: "N25 QA", maxExecutions: 12 });
      send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_n25_2", type: "function", function: { name: "create_recurring_payment", arguments: args } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: "N25 QA complete. " }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
    console.log(`[qa-n25] request #${n}`);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[qa-n25] listening on http://127.0.0.1:${port}/v1`);
});
