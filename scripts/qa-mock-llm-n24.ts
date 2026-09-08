// N24 QA mock: exercises the app-control tools end-to-end through the REAL
// agent loop — create_contact (round 1), then list + cancel recurring (r2/3).
// Usage: bun run scripts/qa-mock-llm-n24.ts [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3994);
let n = 0;

// EIP-55 checksummed (the app's viem isAddress correctly rejects mixed-case
// addresses whose checksum doesn't validate — the first QA runs proved that
// failure path live: honest "A valid 0x address is required." in the trace).
// This is the TRUE checksum form (getAddress-verified).
const ADDR = "0x9F8a7B6c5d4E3F2A1B0c9d8E7f6A5b4c3D2E1f0a";

const server = createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // Skip the /api/agent/test-connection probe ("ping", max_tokens 1, no
    // stream): it validates connectivity and DISCARDS the response — counting
    // it as a scripted round desynced the whole scenario.
    if (body.includes('"ping"')) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      console.log("[qa-n24] probe skipped");
      return;
    }
    n++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    if (n === 1) {
      // Round 1: create_contact
      send({ choices: [{ index: 0, delta: { role: "assistant", content: "Saving Alice to your contacts now. " }, finish_reason: null }] });
      const args = JSON.stringify({ label: "QA Alice", address: ADDR, note: "N24 QA" });
      send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_n24_1", type: "function", function: { name: "create_contact", arguments: args } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else if (n === 2) {
      // Round 2: list_recurring_payments
      send({ choices: [{ index: 0, delta: { role: "assistant", content: "Contact saved. Now listing your schedules. " }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_n24_2", type: "function", function: { name: "list_recurring_payments", arguments: "{}" } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      // Round 3+: once a cancel has SUCCEEDED (cancelledAt in the history) the
      // scenario is complete — a naive repeat would just collect honest
      // already-inactive failures until the round budget (observed live).
      const alreadyCancelled = body.includes("cancelledAt") || body.includes("already inactive");
      // Extract the schedule id from the structured tool result
      // (data.schedules[].scheduleId) — the same path a competent model uses.
      // The tool result is JSON-inside-JSON in the request body, so the quotes
      // arrive ESCAPED (\"scheduleId\":\"…\") — match both escaped and bare.
      const m = /scheduleId\\*":\\*"([^"\\]+)/.exec(body);
      if (m && !alreadyCancelled) {
        const id = m[1];
        send({ choices: [{ index: 0, delta: { role: "assistant", content: "Cancelling that schedule now. " }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_n24_3", type: "function", function: { name: "cancel_recurring_payment", arguments: JSON.stringify({ scheduleId: id }) } }] }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ choices: [{ index: 0, delta: { role: "assistant", content: "No active schedules — N24 QA complete. " }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
    console.log(`[qa-n24] request #${n}`);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[qa-n24] listening on http://127.0.0.1:${port}/v1`);
});
