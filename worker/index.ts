import cron from "node-cron";
import { generateDailyEdition, todayDateOnly } from "../src/lib/generateEdition";
import { getSettings } from "../src/lib/settings";
import { prisma } from "../src/lib/prisma";

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

// Filet de sécurité en mode manuel : PAS de génération IA automatique (celle-
// là ne se déclenche jamais toute seule si le planning est désactivé — c'est
// voulu). Ici on parle uniquement de l'aspiration brute des flux RSS
// ("Aspirer les news" sur /direct, forceNoAi — zéro coût IA) : si personne
// n'a rien déclenché du tout un jour donné (ni bouton manuel, ni "Aspirer"),
// on la lance nous-mêmes à midi pour que la base d'articles continue de
// s'étoffer même si personne ne passe sur le site pendant longtemps. Ne se
// déclenche QUE si aucune édition n'existe déjà pour aujourd'hui — jamais en
// double avec quoi que ce soit fait plus tôt dans la journée.
const FALLBACK_HOUR = 12;
const FALLBACK_MINUTE = 0;

async function runOnceNoAi() {
  console.log(`[worker] Aspiration RSS de secours (sans IA) — ${new Date().toISOString()}`);
  try {
    const result = await generateDailyEdition({ forceNoAi: true });
    console.log("[worker] Done:", result);
  } catch (err) {
    console.error("[worker] Aspiration de secours échouée:", err);
  }
}

async function tick() {
  const settings = await getSettings();

  if (settings.editionScheduleEnabled) {
    const { hour, minute, dateKey } = currentHourMinuteInTz(settings.editionTz);
    if (hour === settings.editionHour && minute === settings.editionMinute && lastRunDate !== dateKey) {
      lastRunDate = dateKey;
      await runOnce();
    }
    return;
  }

  // Planning désactivé (mode manuel, bouton sur l'accueil) : on ne fait rien
  // tant qu'il n'est pas midi, et on ne relance jamais deux fois le même
  // jour (que ce soit nous-mêmes ou une action manuelle).
  const { hour, minute, dateKey } = currentHourMinuteInTz(settings.editionTz);
  if (hour === FALLBACK_HOUR && minute === FALLBACK_MINUTE && lastRunDate !== dateKey) {
    lastRunDate = dateKey;
    const existing = await prisma.edition.findFirst({ where: { date: todayDateOnly() } });
    if (!existing) {
      await runOnceNoAi();
    } else {
      console.log("[worker] Déjà de l'activité aujourd'hui — pas d'aspiration de secours.");
    }
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
