// Slow-stream mock for N22 cursor-position QA: streams a multi-paragraph
// answer word-by-word with a delay so the DOM can be inspected MID-STREAM.
// The correct state: exactly ONE cursor element, riding inline at the end of
// the LAST paragraph (never on completed paragraphs above).
// Usage: bun run scripts/qa-mock-llm-slow.ts [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3997);

const TEXT = `First paragraph introduces the transfer plan and mentions the amount clearly.

Second paragraph explains the Attestcoin verification step in detail for the user.

Third paragraph will be the live end while streaming continues here.`;

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
    const words = TEXT.split(" ");
    let i = 0;
    const tick = setInterval(() => {
      if (i >= words.length) {
        clearInterval(tick);
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      send({ choices: [{ index: 0, delta: { role: "assistant", content: words[i] + " " }, finish_reason: null }] });
      i++;
    }, 550);
    // Watch the RESPONSE lifecycle (the request stream's 'close' fires as
    // soon as the body is consumed — that would kill the interval instantly).
    res.on("close", () => clearInterval(tick));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[qa-mock-llm-slow] listening on http://127.0.0.1:${port}/v1 (550ms/word)`);
});
