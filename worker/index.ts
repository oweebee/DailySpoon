import cron from "node-cron";
import { generateDailyEdition } from "../src/lib/generateEdition";

// Self-hosted daily scheduler (no Vercel cron needed).
// Runs once a day at HOUR:MINUTE in the given timezone — configurable via env
// so you can pick when your "morning edition" comes out.
const HOUR = process.env.EDITION_HOUR || "6";
const MINUTE = process.env.EDITION_MINUTE || "0";
const TZ = process.env.EDITION_TZ || "Europe/Paris";
const CRON_EXPR = `${MINUTE} ${HOUR} * * *`;

console.log(`[worker] DailySpoon worker started. Daily edition scheduled at ${HOUR}:${MINUTE} (${TZ}).`);
console.log(`[worker] Cron expression: "${CRON_EXPR}"`);

async function runOnce() {
  console.log(`[worker] Generating edition — ${new Date().toISOString()}`);
  try {
    const result = await generateDailyEdition();
    console.log(`[worker] Done:`, result);
  } catch (err) {
    console.error("[worker] Generation failed:", err);
  }
}

cron.schedule(CRON_EXPR, runOnce, { timezone: TZ });

// Also run once immediately on boot if RUN_ON_START=true (handy for first deploy/testing).
if (process.env.RUN_ON_START === "true") {
  runOnce();
}

// Keep the process alive.
process.stdin.resume();
