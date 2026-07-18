import cron from "node-cron";
import { generateDailyEdition, todayDateOnly } from "../src/lib/generateEdition";
import { getSettings } from "../src/lib/settings";
import { prisma } from "../src/lib/prisma";
import { healthCheckRedditFeeds } from "../src/lib/redditFeedHealth";

// Self-hosted daily scheduler (no Vercel cron needed).
// Checked every minute against the current /admin/settings (or env var
// fallback) so that changing the schedule from the admin UI takes effect
// immediately — no restart or redeploy needed.

let lastRunDate: string | null = null;
let lastFallbackSlot: string | null = null;

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
// ("Aspirer les news" sur /direct, forceNoAi — zéro coût IA), relancée
// toutes les FALLBACK_INTERVAL_HOURS heures pour que la base d'articles
// continue de s'étoffer même si personne ne passe sur le site pendant
// longtemps. fetchNewItemsFromSelectedCategories dédoublonne déjà par
// freshrssItemId, donc relancer souvent ne coûte rien de plus qu'un appel
// réseau vers FreshRSS si rien de neuf n'est paru entre-temps.
const FALLBACK_INTERVAL_HOURS = 3;

async function runOnceNoAi() {
  console.log(`[worker] Aspiration RSS de secours (sans IA) — ${new Date().toISOString()}`);
  try {
    const result = await generateDailyEdition({ forceNoAi: true });
    console.log("[worker] Done:", result);
  } catch (err) {
    console.error("[worker] Aspiration de secours échouée:", err);
  }
}

// Bascule automatique des flux Reddit vers un miroir Redlib (voir
// redditFeedHealth.ts) — pure maintenance réseau, ZÉRO coût IA, tourne donc
// dans tous les cas (mode auto ou manuel), à un intervalle plus espacé
// qu'un simple tick puisqu'il ne s'agit que de vérifier que les flux
// répondent toujours.
const REDDIT_HEALTH_INTERVAL_HOURS = 6;
let lastRedditHealthSlot: string | null = null;

async function maybeRunRedditHealthCheck(tz: string) {
  const { hour, minute, dateKey } = currentHourMinuteInTz(tz);
  const slot = `${dateKey}-${Math.floor(hour / REDDIT_HEALTH_INTERVAL_HOURS)}`;
  if (minute !== 5 || hour % REDDIT_HEALTH_INTERVAL_HOURS !== 0 || lastRedditHealthSlot === slot) return;
  lastRedditHealthSlot = slot;
  try {
    const result = await healthCheckRedditFeeds();
    if (result.switched.length > 0) {
      console.log(`[worker] Flux Reddit basculés vers Redlib : ${result.switched.join(", ")}`);
    }
  } catch (err) {
    console.error("[worker] Vérification des flux Reddit échouée:", err);
  }
}

async function tick() {
  const settings = await getSettings();

  await maybeRunRedditHealthCheck(settings.editionTz);

  if (settings.editionScheduleEnabled) {
    const { hour, minute, dateKey } = currentHourMinuteInTz(settings.editionTz);
    if (hour === settings.editionHour && minute === settings.editionMinute && lastRunDate !== dateKey) {
      lastRunDate = dateKey;
      await runOnce();
    }
    return;
  }

  // Planning désactivé (mode manuel, bouton sur l'accueil) : aspiration de
  // secours à chaque créneau de FALLBACK_INTERVAL_HOURS heures (00h, 03h,
  // 06h...), une seule fois par créneau.
  const { hour, minute, dateKey } = currentHourMinuteInTz(settings.editionTz);
  const slot = `${dateKey}-${Math.floor(hour / FALLBACK_INTERVAL_HOURS)}`;
  if (minute === 0 && hour % FALLBACK_INTERVAL_HOURS === 0 && lastFallbackSlot !== slot) {
    lastFallbackSlot = slot;
    await runOnceNoAi();
  }
}

console.log("[worker] DailySpoon worker started — checking the schedule (from /admin/settings) every minute.");

cron.schedule("* * * * *", tick);

// Also run once immediately on boot if RUN_ON_START=true (handy for first
// deploy/testing UNIQUEMENT — ce n'est pas censé rester activé en
// permanence, voir /admin/settings ou les variables d'env Coolify) — mais
// SEULEMENT si le planning auto est actif (editionScheduleEnabled) ET
// SEULEMENT si aucune édition n'existe déjà pour aujourd'hui. Double
// garde-fou : le premier (editionScheduleEnabled) évite une impression IA
// surprise en mode manuel ; le second (édition du jour déjà là) évite
// qu'un redéploiement Coolify répété plusieurs fois la même journée (courant
// en itérant sur des correctifs) ne relance une génération IA COMPLÈTE
// (coût réel de tokens) à CHAQUE redémarrage du conteneur — avant ce
// second garde-fou, RUN_ON_START laissé actif dans Coolify (oubli après le
// tout premier déploiement) pouvait facturer une impression par
// redéploiement, potentiellement plusieurs fois par jour en pleine
// itération.
if (process.env.RUN_ON_START === "true") {
  getSettings().then(async (settings) => {
    if (!settings.editionScheduleEnabled) {
      console.log(
        "[worker] RUN_ON_START ignoré : planning auto désactivé (mode manuel) — aucune génération IA au démarrage."
      );
      return;
    }
    const existing = await prisma.edition.findFirst({ where: { date: todayDateOnly() } });
    if (existing) {
      console.log(
        "[worker] RUN_ON_START ignoré : une édition existe déjà pour aujourd'hui — pas de nouvelle génération IA à chaque redémarrage."
      );
      return;
    }
    lastRunDate = currentHourMinuteInTz(settings.editionTz).dateKey;
    runOnce();
  });
}

// Keep the process alive.
process.stdin.resume();
