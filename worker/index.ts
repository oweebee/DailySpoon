import cron from "node-cron";
import { generateDailyEdition, todayDateOnly } from "../src/lib/generateEdition";
import { getSettings } from "../src/lib/settings";
import { prisma } from "../src/lib/prisma";
import { healthCheckRedditFeeds } from "../src/lib/redditFeedHealth";
import { refreshRedlibInstanceCache } from "../src/lib/reddit";
import { syncCustomFeeds } from "../src/lib/customFeeds";
import { writeLog, pruneOldLogs } from "../src/lib/logger";

// Self-hosted daily scheduler (no Vercel cron needed).
// Checked every minute against the current /admin/settings (or env var
// fallback) so that changing the schedule from the admin UI takes effect
// immediately — no restart or redeploy needed.

let lastRunDate: string | null = null;
let lastFallbackRunAt: number | null = null;

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
    await writeLog("error", "worker", "Génération quotidienne échouée", (err as Error)?.message);
  }
}

// Filet de sécurité en mode manuel : PAS de génération IA automatique (celle-
// là ne se déclenche jamais toute seule si le planning est désactivé — c'est
// voulu). Ici on parle uniquement de l'aspiration brute des flux RSS
// ("Aspirer les news" sur /direct, forceNoAi — zéro coût IA), relancée au
// même rythme que Settings.customFeedsIntervalMinutes (réglage "Intervalle
// de récupération" dans /admin/settings) — PLUS de durée fixe codée en dur
// séparément : un seul réglage pilote maintenant à la fois cette aspiration
// de secours FreshRSS ET les flux personnalisés (voir maybeSyncCustomFeeds
// plus bas), sur demande explicite. fetchNewItemsFromSelectedCategories
// dédoublonne déjà par freshrssItemId, donc relancer souvent ne coûte rien
// de plus qu'un appel réseau vers FreshRSS si rien de neuf n'est paru
// entre-temps.
async function runOnceNoAi() {
  console.log(`[worker] Aspiration RSS de secours (sans IA) — ${new Date().toISOString()}`);
  try {
    const result = await generateDailyEdition({ forceNoAi: true });
    console.log("[worker] Done:", result);
  } catch (err) {
    await writeLog("error", "worker", "Aspiration de secours échouée", (err as Error)?.message);
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
  // Rafraîchit d'abord le cache des miroirs Redlib (voir reddit.ts) — sonde
  // la liste officielle + repli statique et écrit le résultat en base, AVANT
  // healthCheckRedditFeeds ci-dessous, qui va justement s'en servir pour
  // basculer les abonnements FreshRSS en échec. Best-effort, ne bloque jamais
  // le health-check des abonnements si ça échoue.
  try {
    const { healthy } = await refreshRedlibInstanceCache();
    await writeLog("info", "worker", `Cache miroirs Redlib rafraîchi (${healthy.length} sain(s)) : ${healthy.join(", ")}`);
  } catch (err) {
    await writeLog("error", "worker", "Rafraîchissement du cache Redlib échoué", (err as Error)?.message);
  }
  try {
    const result = await healthCheckRedditFeeds();
    if (result.switched.length > 0) {
      await writeLog("info", "worker", `Flux Reddit basculés vers Redlib : ${result.switched.join(", ")}`);
    }
  } catch (err) {
    await writeLog("error", "worker", "Vérification des flux Reddit échouée", (err as Error)?.message);
  }
}

// Flux RSS personnalisés (voir customFeeds.ts, CustomCategory/CustomFeed) —
// zéro coût IA, tourne dans tous les cas (mode auto ou manuel). Appelé à
// CHAQUE tick (chaque minute) : syncCustomFeeds()/fetchCustomFeedItems()
// s'auto-gate en interne sur Settings.customFeedsIntervalMinutes (5mn à 1
// semaine, réglable dans /admin/settings) — un appel qui n'est pas encore
// dû ne fait qu'une lecture DB, pas de requête réseau vers les flux.
async function maybeSyncCustomFeeds() {
  try {
    const result = await syncCustomFeeds();
    if (result.fetched > 0) {
      console.log(`[worker] Flux personnalisés : ${result.fetched} nouvel(aux) article(s).`);
    }
  } catch (err) {
    // Les échecs PAR FLUX sont déjà loggués individuellement dans
    // customFeeds.ts (writeLog "custom-feeds") — ce catch-ci ne couvre que
    // l'échec de syncCustomFeeds() lui-même (ex. recomputeAllCustomFeedIncluded,
    // souci DB), pas un flux précis.
    await writeLog("error", "worker", "Synchronisation des flux personnalisés échouée", (err as Error)?.message);
  }
}

async function tick() {
  const settings = await getSettings();

  // Purge du journal (/admin/logs) — DELETE indexé sur createdAt, négligeable
  // même appelé chaque minute (voir logger.ts). S'auto-gate en interne sur
  // Settings.logRetentionMinutes (0 = illimité, ne fait rien).
  await pruneOldLogs();

  await maybeRunRedditHealthCheck(settings.editionTz);
  await maybeSyncCustomFeeds();

  if (settings.editionScheduleEnabled) {
    const { hour, minute, dateKey } = currentHourMinuteInTz(settings.editionTz);
    if (hour === settings.editionHour && minute === settings.editionMinute && lastRunDate !== dateKey) {
      lastRunDate = dateKey;
      await runOnce();
    }
    return;
  }

  // Planning désactivé (mode manuel, bouton sur l'accueil) : aspiration de
  // secours dès que Settings.customFeedsIntervalMinutes (réglage "Intervalle
  // de récupération", /admin/settings) est écoulé depuis la dernière fois —
  // même mécanique à base d'écart de temps que fetchCustomFeedItems (voir
  // customFeeds.ts), plus de créneaux alignés sur l'horloge (00h/03h/06h...).
  // "lastFallbackRunAt" est en mémoire (pas persisté en base) : redémarre à
  // null à chaque redéploiement, donc la toute première aspiration après un
  // déploiement se relance immédiatement plutôt que d'attendre un créneau —
  // déjà le comportement de fetchCustomFeedItems pour un tout premier flux.
  const fallbackIntervalMs = settings.customFeedsIntervalMinutes * 60_000;
  if (!lastFallbackRunAt || Date.now() - lastFallbackRunAt >= fallbackIntervalMs) {
    lastFallbackRunAt = Date.now();
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
