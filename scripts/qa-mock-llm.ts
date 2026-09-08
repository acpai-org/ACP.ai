// Standalone mock OpenAI-compatible SSE server for browser-level agent QA.
// Usage: bun run scripts/qa-mock-llm.ts [port]
// Replies follow the C1 collision scenario: narration text + tool call in
// round 1, completion text in round 2 — exactly the shape that used to merge
// into one chat bubble. The loop count repeats per request to exercise
// repetition (C1.5).
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3999);

const TOOL_CALL = {
  id: "call_qa_1",
  name: "transfer",
  args: {
    chain: 11155111,
    recipient: "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a",
    token: "USDC",
    amount: "5",
    memo: null,
  },
};

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
    const isRound2 = body.includes("call_qa_1"); // tool result present in messages
    console.log(`[qa-mock-llm] body head: ${body.slice(0, 160).replace(/\s+/g, " ")}`);
    // QA instrumentation: log the last user message + message count per request.
    try {
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
      const msgs = parsed.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      console.log(`[qa-mock-llm] messages=${msgs.length} lastUser=${lastUser ? JSON.stringify(lastUser.content.slice(0, 80)) : "(none)"}`);
    } catch { /* not JSON */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (!isRound2) {
      // Round 1: announcement narration (streamed in fragments) + tool call
      const text = `I am preparing the transfer of 5 USDC on Ethereum Sepolia.`;
      const words = text.split(" ");
      for (const w of words) send({ choices: [{ index: 0, delta: { role: "assistant", content: w + " " }, finish_reason: null }] });
      const argsJson = JSON.stringify(TOOL_CALL.args);
      send({ choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: TOOL_CALL.id, type: "function", function: { name: TOOL_CALL.name, arguments: "" } }] }, finish_reason: null }] });
      const mid = Math.floor(argsJson.length / 2);
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(0, mid) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(mid) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      // Round 2: completion narration with markdown (the old collision blob's tail)
      const text = `The transfer attempt has completed. ### Transfer Summary\n\n- Amount: 5 USDC\n- Chain: Ethereum Sepolia (Chain ID: 11155111)\n- Recipient: 0x9f8a…1F0a\n\nLet me know if there's anything else you'd like to do!`;
      const words = text.split(" ");
      for (const w of words) send({ choices: [{ index: 0, delta: { role: "assistant", content: w + " " }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
    console.log(`[qa-mock-llm] request #${n} → ${isRound2 ? "round-2 (completion text)" : "round-1 (announcement + tool call)"}`);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[qa-mock-llm] listening on http://127.0.0.1:${port}/v1 (2-round C1 scenario)`);
});
