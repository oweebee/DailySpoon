import cron from "node-cron";
import { generateDailyEdition } from "../src/lib/generateEdition";
import { getSettings } from "../src/lib/settings";

// Self-hosted daily scheduler (no Vercel cron needed).
// Checked every minute against the current /admin/settings (or env var
// fallback) so that changing the schedule from the admin UI takes effect
// immediately — no restart or redeploy needed.

let lastRunDate: string | null = null;

function currentHourMinuteInTz(tz: string): { hour: number; minute: number; dateKey: string } {
  const now = new Date();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
  } catch {
    console.warn(`[worker] Invalid timezone "${tz}", falling back to UTC.`);
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
  }

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`
  };
}

async function runOnce() {
  console.log(`[worker] Generating edition — ${new Date().toISOString()}`);
  try {
    const result = await generateDailyEdition();
    console.log("[worker] Done:", result);
  } catch (err) {
    console.error("[worker] Generation failed:", err);
  }
}

async function tick() {
  const settings = await getSettings();
  const { hour, minute, dateKey } = currentHourMinuteInTz(settings.editionTz);

  if (hour === settings.editionHour && minute === settings.editionMinute && lastRunDate !== dateKey) {
    lastRunDate = dateKey;
    await runOnce();
  }
}

console.log("[worker] DailySpoon worker started — checking the schedule (from /admin/settings) every minute.");

cron.schedule("* * * * *", tick);

// Also run once immediately on boot if RUN_ON_START=true (handy for first deploy/testing).
if (process.env.RUN_ON_START === "true") {
  getSettings().then((settings) => {
    lastRunDate = currentHourMinuteInTz(settings.editionTz).dateKey;
    runOnce();
  });
}

// Keep the process alive.
process.stdin.resume();
