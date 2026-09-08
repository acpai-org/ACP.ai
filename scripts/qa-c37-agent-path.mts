// One-off C37 QA: drive the REAL agent-side executor (execCreateRecurringPayment)
// with a custom intervalHours against an isolated DB; assert the stored cadence
// spec + next-fire math. Also re-check the fire executor on the custom spec.
process.env.ACP_DB_PATH = "/tmp/acp-c37-qa.db";
import { unlinkSync, existsSync } from "node:fs";
if (existsSync("/tmp/acp-c37-qa.db")) unlinkSync("/tmp/acp-c37-qa.db");

const { execCreateRecurringPayment } = await import("@/lib/agent/server-tools");
const { fireRecurringSchedule } = await import("@/lib/recurring/fire");
const { db } = await import("@/db");
const { recurringSchedules } = await import("@/db/schema");
const { eq } = await import("drizzle-orm");

const RECIPIENT = "0x9f8a7B6c5D4e3F2a1B0c9D8e7F6a5B4c3D2e1F0a";

// 1. Custom: every 6 hours via intervalHours
const custom = await execCreateRecurringPayment(
  { recipient: RECIPIENT, token: "USDC", amount: "5", chain: 11155111, cadence: "weekly", intervalHours: 6, memo: "C37 QA custom", maxExecutions: 3 },
  { wallet: { address: "0xQA0000000000000000000000000000000000QA", chainId: 11155111 } } as never,
);
console.log("[1] custom summary:", custom.summary);
const row1 = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, custom.data!.scheduleId as string)).all()[0];
console.log("[1] stored cadence:", row1.cadence, "| nextFire in (h):", Math.round((row1.nextFireAt - Date.now() / 1000) / 360) / 10);
if (row1.cadence !== "every-6h") throw new Error("FAIL: expected every-6h, got " + row1.cadence);
if (Math.abs(row1.nextFireAt - Date.now() / 1000 - 6 * 3600) > 60) throw new Error("FAIL: next fire not ~6h away");

// 2. Preset daily (new preset through the agent path)
const daily = await execCreateRecurringPayment(
  { recipient: RECIPIENT, token: "USDC", amount: "2", chain: 11155111, cadence: "daily", memo: null, maxExecutions: null },
  { wallet: null } as never,
);
const row2 = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, daily.data!.scheduleId as string)).all()[0];
console.log("[2] daily stored cadence:", row2.cadence);
if (row2.cadence !== "daily") throw new Error("FAIL: expected daily");
if (Math.abs(row2.nextFireAt - Date.now() / 1000 - 86400) > 60) throw new Error("FAIL: daily next fire not ~24h away");

// 3. Fire the custom schedule (force due) and confirm 6h advancement + action row
db.update(recurringSchedules).set({ nextFireAt: Math.floor(Date.now() / 1000) - 60 }).where(eq(recurringSchedules.id, row1.id)).run();
const fired = fireRecurringSchedule(row1.id, "fired");
if (!fired.ok || fired.skipped) throw new Error("FAIL: custom schedule did not fire: " + JSON.stringify(fired));
const after = db.select().from(recurringSchedules).where(eq(recurringSchedules.id, row1.id)).all()[0];
const advanced = after.nextFireAt - fired.firedAt;
console.log("[3] fired; next slot in (h):", Math.round(advanced / 360) / 10);
if (advanced <= 0 || advanced > 6 * 3600) throw new Error("FAIL: next slot not within one 6h interval: " + advanced);
if (after.executions !== 1) throw new Error("FAIL: executions should be 1");

console.log("C37 AGENT-PATH QA: ALL PASS");
unlinkSync("/tmp/acp-c37-qa.db");
process.exit(0);
